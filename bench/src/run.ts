import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadTrace } from "../../src/trace.js";
import {
  changeSafelyInvocation,
  changeSafelyUsage,
  directInvocation,
  parseChangeSafelyOutcome,
  parseDirectEvidence,
  type UsageEvidence,
} from "./adapters.js";
import {
  collectEnvironmentVersions,
  ensureComparisonManifest,
  type StoredComparison,
} from "./comparison.js";
import {
  type BenchmarkMeasurement,
  type BenchmarkMode,
  type BenchmarkOutcome,
  EVIDENCE_VERSION,
  type EvaluationDocument,
  type RunDocument,
  validateEvaluationDocument,
} from "./contracts.js";
import { classifyTechnicalFailure, type TechnicalFailure } from "./controller.js";
import {
  contentSha256,
  createEvidencePackage,
  listEvidencePackages,
  type VerifiedEvidence,
} from "./evidence.js";
import { type IsolationProof, prepareCodexHome, proveIsolation } from "./isolation.js";
import { type ProcessResult, runProcess } from "./process.js";
import {
  materializeAttempt,
  type ScenarioDefinition,
  scenarioDefinition,
  snapshotAttempt,
} from "./repository.js";

const PERMISSION_PROFILE = "changesafely-benchmark";

interface Command {
  program: string;
  prefixArgs?: string[];
}

export interface BenchmarkAttemptOptions {
  projectRoot: string;
  benchRoot: string;
  resultsRoot: string;
  scenario: string;
  mode: BenchmarkMode;
  measurement?: BenchmarkMeasurement;
  model: string;
  effort: string;
  timeoutMs: number;
  codexCommand: string;
  sourceCodexHome?: string;
  directCommand?: Command;
  changeSafelyCommand?: Command;
  isolationProof?: IsolationProof;
}

export async function runBenchmarkAttempt(
  options: BenchmarkAttemptOptions,
): Promise<VerifiedEvidence> {
  if (options.effort !== "medium") {
    throw new Error("Fair benchmark attempts require medium reasoning effort in both modes");
  }
  const temporaryRoot = await mkdtemp(join(homedir(), ".changesafely-benchmark-attempt-"));
  try {
    const scenario = scenarioDefinition(options.benchRoot, options.scenario);
    const taskText = await readFile(scenario.task, "utf8");
    const attempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace"));
    const environment = await collectEnvironmentVersions(
      options.codexCommand,
      options.projectRoot,
      scenario.toolchains,
      attempt.workspace,
    );
    const evaluatorSha256 = contentSha256(await readFile(scenario.evaluator));
    const measurement = options.measurement ?? "development";
    const comparison = await ensureComparisonManifest(options.resultsRoot, {
      measurement,
      scenario: scenario.id,
      scenarioVersion: scenario.version,
      taskText,
      taskSha256: contentSha256(taskText),
      baselineCommit: attempt.baselineCommit,
      model: options.model,
      effort: options.effort,
      timeoutMs: options.timeoutMs,
      permissionProfile: PERMISSION_PROFILE,
      agentToolNetwork: "disabled",
      scenarioManifestSha256: scenario.manifestSha256,
      oracleSha256: scenario.oracleSha256,
      preparation: scenario.preparation,
      visibleChecks: scenario.visibleChecks,
      evaluatorSha256,
      executionOrder: ["direct", "changesafely"],
      maxAttemptsPerMode: 1,
      environment,
    });
    await enforceExecutionOrder(options.resultsRoot, comparison, options.mode);

    const codexHome = join(temporaryRoot, "codex-home");
    const isolation =
      options.isolationProof ??
      (await prepareAndProveIsolation(
        options.sourceCodexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        codexHome,
        options.codexCommand,
        attempt.workspace,
        options.projectRoot,
        scenario,
      ));
    const env = benchmarkWorkerEnvironment(codexHome, options.codexCommand, options.projectRoot);
    const invocation =
      options.mode === "direct"
        ? directInvocation({
            ...(options.directCommand ?? { program: options.codexCommand }),
            workspace: attempt.workspace,
            taskText,
            model: options.model,
            effort: options.effort,
            permissionProfile: PERMISSION_PROFILE,
            timeoutMs: options.timeoutMs,
            env,
          })
        : changeSafelyInvocation({
            ...(options.changeSafelyCommand ?? {
              program: process.execPath,
              prefixArgs: [join(options.projectRoot, "dist", "src", "cli.js")],
            }),
            workspace: attempt.workspace,
            taskText,
            model: options.model,
            effort: options.effort,
            permissionProfile: PERMISSION_PROFILE,
            timeoutMs: options.timeoutMs,
            env,
          });

    const worker = await runProcess(invocation);
    const adapter = await parseAdapterEvidence(options.mode, attempt.workspace, worker);
    const technicalFailure = classifyTechnicalFailure({
      started: worker.started,
      exitCode: adapter.acceptsNonzeroExit ? 0 : worker.exitCode,
      signal: worker.signal,
      timedOut: worker.timedOut,
      outputPresent: worker.stdoutBytes > 0,
      eventsValid: adapter.valid,
    });
    const snapshot = await snapshotAttempt(attempt.workspace, attempt.baselineCommit);
    const evaluated = await evaluateScenario(scenario.evaluator, attempt.workspace);
    const outcome = classifyOutcome(technicalFailure, evaluated.document);
    const runId = createRunId(scenario.id, options.mode);
    const comparisonContent = await readFile(comparison.path);
    const evidenceFiles: Record<string, string | Buffer> = {
      "comparison.json": comparisonContent,
      "diff.patch": snapshot.diff,
      "events.jsonl": adapter.events,
      "evaluation.json": evaluated.content,
      "worker.json": `${JSON.stringify(processEvidence(worker, technicalFailure), null, 2)}\n`,
      ...adapter.files,
    };
    const run: RunDocument = {
      evidenceVersion: EVIDENCE_VERSION,
      runId,
      comparisonId: comparison.manifest.comparisonId,
      comparisonSha256: comparison.sha256,
      scenario: scenario.id,
      scenarioVersion: scenario.version,
      mode: options.mode,
      measurement,
      taskText,
      taskSha256: contentSha256(taskText),
      baselineCommit: snapshot.baselineCommit,
      snapshotCommit: snapshot.snapshotCommit,
      model: options.model,
      effort: options.effort,
      environment,
      isolation: {
        provider: isolation.provider,
        permissionProfile: isolation.permissionProfile,
        canarySha256: isolation.canarySha256,
        agentToolNetwork: "disabled",
      },
      worker: {
        startedAt: worker.startedAt,
        completedAt: worker.completedAt,
        durationMs: worker.durationMs,
        exitCode: worker.exitCode,
        signal: worker.signal,
        timedOut: worker.timedOut,
      },
      usage: adapter.usage,
      outcome,
    };
    return await createEvidencePackage(options.resultsRoot, run, evidenceFiles);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function prepareAndProveIsolation(
  sourceCodexHome: string,
  destinationCodexHome: string,
  codexCommand: string,
  workspace: string,
  projectRoot: string,
  scenario: ScenarioDefinition,
): Promise<IsolationProof> {
  await prepareCodexHome(
    sourceCodexHome,
    destinationCodexHome,
    PERMISSION_PROFILE,
    dirname(dirname(process.execPath)),
    await benchmarkRuntimeRoots(scenario),
  );
  return await proveIsolation(
    codexCommand,
    destinationCodexHome,
    workspace,
    join(projectRoot, "bench", "BENCHMARK_SPEC.md"),
    PERMISSION_PROFILE,
  );
}

async function benchmarkRuntimeRoots(scenario: ScenarioDefinition): Promise<string[]> {
  const programs = new Set(
    [
      ...scenario.visibleChecks,
      ...scenario.preparation,
      ...scenario.toolchains.map(({ version }) => version),
    ]
      .map(({ argv }) => argv[0])
      .filter((program): program is string => Boolean(program)),
  );
  const roots = await Promise.all([...programs].map(executableRuntimeRoot));
  return [...new Set(roots)];
}

async function executableRuntimeRoot(program: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const executable = resolve(
      directory,
      process.platform === "win32" ? `${program}.cmd` : program,
    );
    try {
      await access(executable, constants.X_OK);
      return dirname(dirname(executable));
    } catch {
      // Continue through the trusted controller PATH.
    }
  }
  throw new Error(`Benchmark toolchain executable is unavailable: ${program}`);
}

async function parseAdapterEvidence(
  mode: BenchmarkMode,
  workspace: string,
  worker: ProcessResult,
): Promise<{
  valid: boolean;
  acceptsNonzeroExit: boolean;
  events: string;
  usage: RunDocument["usage"];
  files: Record<string, string | Buffer>;
}> {
  const emptyUsage = usageDocument();
  try {
    if (mode === "direct") {
      const direct = parseDirectEvidence(worker.stdout);
      return {
        valid: true,
        acceptsNonzeroExit: false,
        events: direct.eventsJsonl,
        usage: { turns: direct.turns, ...direct.usage },
        files: { "direct/final-message.txt": direct.finalMessage },
      };
    }

    const outcome = parseChangeSafelyOutcome(worker.stdout);
    const runRoot = join(workspace, ".changesafely", "runs", outcome.runId);
    const traceResult = await loadTrace(workspace, outcome.runId)
      .then((trace) => ({ trace }))
      .catch((error: unknown) => ({ error }));
    const trace = "trace" in traceResult ? traceResult.trace : undefined;
    const traceError = "error" in traceResult ? traceResult.error : undefined;
    const events =
      trace === undefined
        ? `${JSON.stringify({
            type: "changesafely.trace.unavailable",
            runId: outcome.runId,
            reason:
              traceError instanceof Error
                ? traceError.message.slice(0, 2_000)
                : String(traceError).slice(0, 2_000),
          })}\n`
        : `${trace.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    return {
      valid: true,
      acceptsNonzeroExit: true,
      events,
      usage: trace === undefined ? emptyUsage : usageDocument(changeSafelyUsage(trace.events)),
      files: {
        "changesafely/outcome.json": worker.stdout.endsWith("\n")
          ? worker.stdout
          : `${worker.stdout}\n`,
        ...((await pathExists(runRoot)) ? await collectTree(runRoot, "changesafely/run") : {}),
      },
    };
  } catch {
    const files = invalidRuntimeEvidence(mode, worker);
    return {
      valid: false,
      acceptsNonzeroExit: false,
      events: `${JSON.stringify({
        type: "runtime.evidence.invalid",
        stdoutBytes: worker.stdoutBytes,
        stdoutSha256: worker.stdoutSha256,
        stderrBytes: worker.stderrBytes,
        stderrSha256: worker.stderrSha256,
      })}\n`,
      usage: emptyUsage,
      files,
    };
  }
}

function invalidRuntimeEvidence(
  mode: BenchmarkMode,
  worker: ProcessResult,
): Record<string, string> {
  if (mode !== "changesafely") return {};
  const files: Record<string, string> = {};
  if (worker.stdoutBytes > 0 && !worker.stdoutTruncated) {
    files["changesafely/invalid-stdout.txt"] = worker.stdout.endsWith("\n")
      ? worker.stdout
      : `${worker.stdout}\n`;
  }
  if (worker.stderrBytes > 0 && !worker.stderrTruncated) {
    files["changesafely/invalid-stderr.txt"] = worker.stderr.endsWith("\n")
      ? worker.stderr
      : `${worker.stderr}\n`;
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function evaluateScenario(
  evaluator: string,
  workspace: string,
): Promise<{ content: string; document?: EvaluationDocument }> {
  const result = await runProcess({
    program: process.execPath,
    args: [evaluator, workspace],
    cwd: workspace,
    env: {
      ...process.env,
      CHANGESAFELY_TELEMETRY: "0",
      CHANGESAFELY_SENTRY_DSN: "",
      GIT_TERMINAL_PROMPT: "0",
      NO_UPDATE_NOTIFIER: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
    },
    timeoutMs: 180_000,
  });
  try {
    if (result.exitCode !== 0 || result.signal || result.timedOut) {
      throw new Error("evaluator process failed");
    }
    const value: unknown = JSON.parse(result.stdout);
    const document = validateEvaluationDocument(value);
    return { content: `${JSON.stringify(document, null, 2)}\n`, document };
  } catch {
    return {
      content: `${JSON.stringify(
        {
          schemaVersion: 1,
          technicalError: "Evaluator did not produce a valid result",
          process: processEvidence(result),
        },
        null,
        2,
      )}\n`,
    };
  }
}

function classifyOutcome(
  technicalFailure: TechnicalFailure | undefined,
  evaluation: EvaluationDocument | undefined,
): BenchmarkOutcome {
  if (technicalFailure || !evaluation) return "technical_failure";
  if (!evaluation.summary.visible) return "visible_failure";
  const behaviorPassed = evaluation.summary.acceptance && evaluation.summary.preservation;
  if (behaviorPassed && !evaluation.summary.scope) return "scope_failure";
  if (!behaviorPassed || !evaluation.summary.scope) return "unsafe_green";
  return "safe_success";
}

async function enforceExecutionOrder(
  resultsRoot: string,
  comparison: StoredComparison,
  mode: BenchmarkMode,
): Promise<void> {
  const runs: RunDocument[] = [];
  for (const evidence of await listEvidencePackages(resultsRoot)) {
    if (evidence.run.comparisonId === comparison.manifest.comparisonId) runs.push(evidence.run);
  }
  if (runs.some((run) => run.mode === mode)) {
    throw new Error(`${mode} already has an attempt in ${comparison.manifest.comparisonId}`);
  }
  if (mode === "direct" && runs.length > 0) {
    throw new Error("Direct must be the first attempt in a comparison");
  }
  if (mode === "changesafely" && !runs.some((run) => run.mode === "direct")) {
    throw new Error("Run Direct before ChangeSafely for the registered comparison");
  }
}

async function collectTree(root: string, prefix: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  await walk(root, prefix, files);
  return files;
}

async function walk(root: string, prefix: string, files: Record<string, Buffer>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const source = join(root, entry.name);
    const target = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in ChangeSafely evidence: ${target}`);
    if (entry.isDirectory()) await walk(source, target, files);
    else if (entry.isFile()) files[target] = await readFile(source);
    else throw new Error(`Unsupported ChangeSafely evidence entry: ${target}`);
  }
}

export function benchmarkWorkerEnvironment(
  codexHome: string,
  codexCommand: string,
  projectRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const localBin = resolve(projectRoot, "node_modules", ".bin");
  const path = [dirname(codexCommand), ...(source.PATH ?? "").split(delimiter)].filter(
    (directory, index, values) =>
      directory && resolve(directory) !== localBin && values.indexOf(directory) === index,
  );
  return {
    ...source,
    PATH: path.join(delimiter),
    CODEX_HOME: codexHome,
    CHANGESAFELY_TELEMETRY: "0",
    CHANGESAFELY_SENTRY_DSN: "",
    GIT_TERMINAL_PROMPT: "0",
    NO_UPDATE_NOTIFIER: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
  };
}

function usageDocument(usage?: UsageEvidence): RunDocument["usage"] {
  return {
    turns: usage?.turns ?? null,
    totalTokens: usage?.totalTokens ?? null,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    nonCachedInputTokens: usage?.nonCachedInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
  };
}

function processEvidence(result: ProcessResult, technical?: TechnicalFailure) {
  return {
    started: result.started,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutSha256: result.stdoutSha256,
    stderrSha256: result.stderrSha256,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(result.error ? { error: result.error.slice(0, 2_000) } : {}),
    ...(technical ? { technicalFailure: technical.reason } : {}),
  };
}

function createRunId(scenario: string, mode: BenchmarkMode): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, "");
  return `${scenario}-${mode}-${timestamp}-${randomUUID().slice(0, 8)}`;
}
