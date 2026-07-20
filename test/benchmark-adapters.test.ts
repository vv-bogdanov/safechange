import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  changeSafelyInvocation,
  directInvocation,
  parseChangeSafelyOutcome,
  parseDirectEvidence,
} from "../bench/src/adapters.js";
import {
  type ComparisonInput,
  collectEnvironmentVersions,
  ensureComparisonManifest,
} from "../bench/src/comparison.js";
import { contentSha256, readVerifiedEvidenceFile } from "../bench/src/evidence.js";
import { runProcess } from "../bench/src/process.js";
import { scenarioDefinition } from "../bench/src/repository.js";
import { benchmarkWorkerEnvironment, runBenchmarkAttempt } from "../bench/src/run.js";

const taskText = "Make payment retries idempotent.\nKeep the public API unchanged.\n";
const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-benchmark-worker.js");

test("Direct adapter sends exact task bytes and retains only safe JSONL evidence", async (t) => {
  const workspace = await temporaryWorkspace(t, "changesafely-direct-adapter-");
  const result = await runProcess(
    directInvocation({
      program: process.execPath,
      prefixArgs: [fixture, "direct"],
      workspace,
      taskText,
      model: "gpt-5.3-codex-spark",
      effort: "medium",
      permissionProfile: "changesafely-benchmark",
      timeoutMs: 10_000,
      env: { ...process.env, BENCHMARK_EXPECTED_TASK: taskText },
    }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const evidence = parseDirectEvidence(result.stdout);
  assert.equal(evidence.finalMessage, "Fake Direct completed.");
  assert.equal(evidence.turns, 1);
  assert.equal(evidence.usage.cachedInputTokens, 40);
  assert.doesNotMatch(evidence.eventsJsonl, /private-reasoning-marker/u);
  assert.doesNotMatch(evidence.eventsJsonl, /private-command-output-marker/u);
  assert.match(evidence.eventsJsonl, /outputSha256/u);
});

test("ChangeSafely adapter uses the public CLI contract and retains its run", async (t) => {
  const workspace = await temporaryWorkspace(t, "changesafely-product-adapter-");
  const result = await runProcess(
    changeSafelyInvocation({
      program: process.execPath,
      prefixArgs: [fixture, "changesafely"],
      workspace,
      taskText,
      model: "gpt-5.3-codex-spark",
      effort: "medium",
      permissionProfile: "changesafely-benchmark",
      timeoutMs: 10_000,
      env: { ...process.env, BENCHMARK_EXPECTED_TASK: taskText },
    }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const outcome = parseChangeSafelyOutcome(result.stdout);
  assert.equal(outcome.runId, "fake-run");
  assert.equal(outcome.status, "VERIFIED");
  assert.match(
    await readFile(join(workspace, ".changesafely", "runs", "fake-run", "trace.jsonl"), "utf8"),
    /token\.usage/u,
  );
});

test("comparison manifest is immutable and content-addressed", async (t) => {
  const resultsRoot = await temporaryWorkspace(t, "changesafely-comparison-");
  const input = comparisonInput();
  const first = await ensureComparisonManifest(resultsRoot, input);
  const second = await ensureComparisonManifest(resultsRoot, input);
  assert.equal(first.manifest.comparisonId, second.manifest.comparisonId);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.manifest.taskText, taskText);
  assert.equal(first.manifest.measurement, "development");
  assert.equal(first.manifest.scenarioVersion, 1);
  assert.equal(first.manifest.comparisonVersion, 3);
  assert.deepEqual(first.manifest.visibleChecks, [{ argv: ["npm", "test"], cwd: "." }]);
  assert.equal(first.manifest.environment.toolchains[0]?.id, "node");
});

test("scenario oracle hash covers mutant assets beyond the evaluator", async (t) => {
  const root = await temporaryWorkspace(t, "changesafely-oracle-hash-");
  const benchRoot = join(root, "bench");
  await cp(join(process.cwd(), "bench"), benchRoot, {
    recursive: true,
    filter: (source) => !["golden", "results"].includes(basename(source)),
  });
  const before = scenarioDefinition(benchRoot, "double-charge");
  const evaluatorSha256 = contentSha256(await readFile(before.evaluator));

  await appendFile(
    join(benchRoot, "oracles", "double-charge", "mutants", "constant-provider-key.patch"),
    "\n",
  );
  const after = scenarioDefinition(benchRoot, "double-charge");

  assert.equal(after.manifestSha256, before.manifestSha256);
  assert.equal(contentSha256(await readFile(after.evaluator)), evaluatorSha256);
  assert.notEqual(after.oracleSha256, before.oracleSha256);
});

test("benchmark environment identifies the exact ChangeSafely commit", async () => {
  const environment = await collectEnvironmentVersions(
    process.execPath,
    process.cwd(),
    [{ id: "node", version: { argv: ["node", "--version"], cwd: "." } }],
    process.cwd(),
  );
  assert.match(environment.changesafelyCommit, /^[a-f0-9]{40,64}$/u);
  assert.deepEqual(environment.toolchains, [
    {
      id: "node",
      versionCommand: { argv: ["node", "--version"], cwd: "." },
      version: process.version,
    },
  ]);
});

test("benchmark environment normalizes multiline toolchain versions", async () => {
  const environment = await collectEnvironmentVersions(
    process.execPath,
    process.cwd(),
    [
      {
        id: "multiline",
        version: {
          argv: [process.execPath, "-e", 'process.stdout.write("runtime 1\\nbuild 2\\n")'],
          cwd: ".",
        },
      },
    ],
    process.cwd(),
  );
  assert.equal(environment.toolchains[0]?.version, "runtime 1 build 2");
});

test("benchmark workers cannot resolve Codex from the controller checkout", () => {
  const localBin = join(process.cwd(), "node_modules", ".bin");
  const externalBin = join(tmpdir(), "external-codex-bin");
  const environment = benchmarkWorkerEnvironment(
    "/tmp/benchmark-codex-home",
    join(externalBin, "codex"),
    process.cwd(),
    { PATH: [localBin, externalBin, "/usr/bin"].join(process.platform === "win32" ? ";" : ":") },
  );

  assert.equal(
    environment.PATH,
    [externalBin, "/usr/bin"].join(process.platform === "win32" ? ";" : ":"),
  );
  assert.equal(environment.CODEX_HOME, "/tmp/benchmark-codex-home");
});

test("controller runs a fair fake Direct and ChangeSafely pair end to end", async (t) => {
  const resultsRoot = await temporaryWorkspace(t, "changesafely-paired-run-");
  const common = {
    projectRoot: process.cwd(),
    benchRoot: join(process.cwd(), "bench"),
    resultsRoot,
    scenario: "double-charge",
    measurement: "development" as const,
    model: "gpt-5.3-codex-spark",
    effort: "medium",
    timeoutMs: 10_000,
    codexCommand: process.execPath,
    isolationProof: {
      provider: "codex-permission-profile" as const,
      providerVersion: "test",
      permissionProfile: "changesafely-benchmark",
      canarySha256: "c".repeat(64),
      controllerPathHidden: true,
      authUnreadable: true,
      canaryPathHidden: true,
      agentToolNetworkDisabled: true,
    },
  };
  const direct = await runBenchmarkAttempt({
    ...common,
    mode: "direct",
    directCommand: { program: process.execPath, prefixArgs: [fixture, "direct"] },
  });
  const changesafely = await runBenchmarkAttempt({
    ...common,
    mode: "changesafely",
    changeSafelyCommand: {
      program: process.execPath,
      prefixArgs: [fixture, "changesafely"],
    },
  });

  assert.equal(direct.run.comparisonId, changesafely.run.comparisonId);
  assert.match(direct.run.environment.changesafelyCommit ?? "", /^[a-f0-9]{40,64}$/u);
  assert.deepEqual(
    direct.run.environment.toolchains?.map(({ id }) => id),
    ["node", "npm"],
  );
  const comparison = JSON.parse(await readFile(join(direct.path, "comparison.json"), "utf8")) as {
    comparisonVersion: number;
    scenarioManifestSha256: string;
    oracleSha256: string;
    preparation: Array<{ argv: string[]; cwd: string; network: string }>;
    visibleChecks: Array<{ argv: string[]; cwd: string }>;
  };
  assert.equal(comparison.comparisonVersion, 3);
  assert.match(comparison.scenarioManifestSha256, /^[a-f0-9]{64}$/u);
  assert.match(comparison.oracleSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(comparison.visibleChecks, [{ argv: ["npm", "test"], cwd: "." }]);
  assert.equal(comparison.preparation[0]?.network, "disabled");
  assert.equal(direct.run.scenarioVersion, 4);
  assert.equal(changesafely.run.scenarioVersion, 4);
  assert.equal(direct.run.outcome, "unsafe_green");
  assert.equal(changesafely.run.outcome, "unsafe_green");
  assert.equal(direct.run.usage.inputTokens, 100);
  assert.equal(direct.run.usage.totalTokens, 120);
  assert.equal(direct.run.usage.nonCachedInputTokens, 60);
  assert.equal(changesafely.run.usage.cachedInputTokens, 50);
  assert.equal(changesafely.run.usage.totalTokens, 200);
  assert.equal(changesafely.run.usage.nonCachedInputTokens, 90);
  assert.match(
    await readFile(join(changesafely.path, "changesafely", "run", "trace.jsonl"), "utf8"),
    /token\.usage/u,
  );
  await assert.rejects(
    runBenchmarkAttempt({
      ...common,
      mode: "direct",
      directCommand: { program: process.execPath, prefixArgs: [fixture, "direct"] },
    }),
    /already has an attempt/u,
  );
});

test("controller preserves nonzero ChangeSafely outcomes when trace is unavailable", async (t) => {
  const resultsRoot = await temporaryWorkspace(t, "changesafely-error-outcome-");
  const common = {
    projectRoot: process.cwd(),
    benchRoot: join(process.cwd(), "bench"),
    resultsRoot,
    scenario: "double-charge",
    measurement: "development" as const,
    model: "gpt-5.3-codex-spark",
    effort: "medium",
    timeoutMs: 10_000,
    codexCommand: process.execPath,
    isolationProof: {
      provider: "codex-permission-profile" as const,
      providerVersion: "test",
      permissionProfile: "changesafely-benchmark",
      canarySha256: "c".repeat(64),
      controllerPathHidden: true,
      authUnreadable: true,
      canaryPathHidden: true,
      agentToolNetworkDisabled: true,
    },
  };
  await runBenchmarkAttempt({
    ...common,
    mode: "direct",
    directCommand: { program: process.execPath, prefixArgs: [fixture, "direct"] },
  });

  const changesafely = await runBenchmarkAttempt({
    ...common,
    mode: "changesafely",
    changeSafelyCommand: {
      program: process.execPath,
      prefixArgs: [fixture, "changesafely-no-trace"],
    },
  });

  assert.equal(changesafely.run.worker.exitCode, 1);
  assert.notEqual(changesafely.run.outcome, "technical_failure");
  assert.equal(changesafely.run.usage.totalTokens, null);
  const outcome = JSON.parse(
    await readFile(join(changesafely.path, "changesafely", "outcome.json"), "utf8"),
  ) as { status: string; runId: string };
  assert.equal(outcome.runId, "missing-trace-run");
  assert.equal(outcome.status, "FAILED");
  assert.match(
    await readFile(join(changesafely.path, "events.jsonl"), "utf8"),
    /trace\.unavailable/u,
  );
  await assert.rejects(readFile(join(changesafely.path, "changesafely", "run", "trace.jsonl")));
  assert.match(
    (await readVerifiedEvidenceFile(changesafely, "changesafely/outcome.json")).toString("utf8"),
    /Fake ChangeSafely failed/u,
  );
});

test("controller preserves invalid ChangeSafely process diagnostics locally", async (t) => {
  const resultsRoot = await temporaryWorkspace(t, "changesafely-invalid-output-");
  const common = {
    projectRoot: process.cwd(),
    benchRoot: join(process.cwd(), "bench"),
    resultsRoot,
    scenario: "double-charge",
    measurement: "development" as const,
    model: "gpt-5.3-codex-spark",
    effort: "medium",
    timeoutMs: 10_000,
    codexCommand: process.execPath,
    isolationProof: {
      provider: "codex-permission-profile" as const,
      providerVersion: "test",
      permissionProfile: "changesafely-benchmark",
      canarySha256: "d".repeat(64),
      controllerPathHidden: true,
      authUnreadable: true,
      canaryPathHidden: true,
      agentToolNetworkDisabled: true,
    },
  };
  await runBenchmarkAttempt({
    ...common,
    mode: "direct",
    directCommand: { program: process.execPath, prefixArgs: [fixture, "direct"] },
  });

  const changesafely = await runBenchmarkAttempt({
    ...common,
    mode: "changesafely",
    changeSafelyCommand: {
      program: process.execPath,
      prefixArgs: [fixture, "changesafely-invalid-output"],
    },
  });

  assert.equal(changesafely.run.outcome, "technical_failure");
  assert.match(
    await readFile(join(changesafely.path, "events.jsonl"), "utf8"),
    /runtime\.evidence\.invalid/u,
  );
  assert.match(
    (await readVerifiedEvidenceFile(changesafely, "changesafely/invalid-stdout.txt")).toString(
      "utf8",
    ),
    /not a JSON outcome/u,
  );
  assert.match(
    (await readVerifiedEvidenceFile(changesafely, "changesafely/invalid-stderr.txt")).toString(
      "utf8",
    ),
    /fake app server stderr/u,
  );
});

async function temporaryWorkspace(t: test.TestContext, prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(path, { recursive: true, force: true }));
  return path;
}

function comparisonInput(): ComparisonInput {
  return {
    scenario: "double-charge",
    scenarioVersion: 1,
    measurement: "development",
    taskText,
    taskSha256: contentSha256(taskText),
    baselineCommit: "a".repeat(40),
    model: "gpt-5.3-codex-spark",
    effort: "medium",
    timeoutMs: 3_600_000,
    permissionProfile: "changesafely-benchmark",
    agentToolNetwork: "disabled",
    scenarioManifestSha256: "d".repeat(64),
    oracleSha256: "f".repeat(64),
    preparation: [],
    visibleChecks: [{ argv: ["npm", "test"], cwd: "." }],
    evaluatorSha256: "e".repeat(64),
    executionOrder: ["direct", "changesafely"],
    maxAttemptsPerMode: 1,
    environment: {
      nodeVersion: process.version,
      gitVersion: "git version test",
      codexVersion: "codex-cli test",
      changesafelyVersion: "0.1.0",
      platform: process.platform,
      architecture: process.arch,
      toolchains: [
        {
          id: "node",
          versionCommand: { argv: ["node", "--version"], cwd: "." },
          version: process.version,
        },
      ],
    },
  };
}
