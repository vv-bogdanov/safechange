#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createOrVerifyAnalysisPackage, evaluateMutationEvidence } from "./analysis.js";
import { resolveCodexCommand } from "./comparison.js";
import type { BenchmarkMode } from "./contracts.js";
import { loadEvidencePackage } from "./evidence.js";
import { prepareCodexHome, proveIsolation } from "./isolation.js";
import { buildBenchmarkReport, replayBenchmarkRun, writeBenchmarkReport } from "./report.js";
import { materializeAttempt, scenarioDefinition } from "./repository.js";
import { runBenchmarkAttempt } from "./run.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const benchRoot = join(projectRoot, "bench");
const SPARK_MODEL = "gpt-5.3-codex-spark";

const help = `ChangeSafely Risk Suite

Usage:
  npm run benchmark:smoke -- --scenario <id> --mode direct|changesafely [--model ${SPARK_MODEL}]
  npm run benchmark -- run --scenario <id> --mode direct|changesafely --model <id> --final
  npm run benchmark -- validate --scenario double-charge|tenant-leak|restart-storm
  npm run benchmark -- canary --scenario <id>
  npm run benchmark -- evaluate --run <run-id> [--results <path>]
  npm run benchmark -- replay --run <run-id> [--results <path>]
  npm run benchmark -- report [--results <path>]

Live development runs use Spark. Final measured runs always require a separate explicit
user command after the Spark results have been evaluated.
`;

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        effort: { type: "string", default: "medium" },
        final: { type: "boolean" },
        mode: { type: "string" },
        model: { type: "string" },
        results: { type: "string" },
        run: { type: "string" },
        scenario: { type: "string" },
        timeout: { type: "string", default: "3600" },
      },
    });
    if (parsed.values.help || parsed.positionals.length === 0) {
      process.stdout.write(help);
      return 0;
    }

    const [command, ...extra] = parsed.positionals;
    if (extra.length > 0) throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
    if (command === "validate") {
      const scenario = required(parsed.values.scenario, "--scenario");
      const definition = scenarioDefinition(benchRoot, scenario);
      const validator = join(definition.root, "validate.mjs");
      const { stdout } = await execFileAsync(process.execPath, [validator], {
        cwd: projectRoot,
        timeout: 300_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      process.stdout.write(stdout);
      return 0;
    }

    if (command === "canary") {
      const scenario = scenarioDefinition(
        benchRoot,
        required(parsed.values.scenario, "--scenario"),
      );
      const temporaryRoot = await mkdtemp(join(homedir(), ".changesafely-isolation-proof-"));
      try {
        const attempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace"), {
          installDependencies: false,
        });
        const codexHome = join(temporaryRoot, "codex-home");
        const permissionProfile = "changesafely-benchmark";
        await prepareCodexHome(
          process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          codexHome,
          permissionProfile,
        );
        const proof = await proveIsolation(
          await resolveCodexCommand(projectRoot),
          codexHome,
          attempt.workspace,
          join(projectRoot, "bench", "BENCHMARK_SPEC.md"),
          permissionProfile,
        );
        process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      return 0;
    }

    if (command === "run") {
      const scenario = required(parsed.values.scenario, "--scenario");
      const mode = benchmarkMode(required(parsed.values.mode, "--mode"));
      const finalMeasurement = parsed.values.final ?? false;
      const explicitModel = parsed.values.model?.trim();
      if (finalMeasurement && !explicitModel) {
        throw new Error("--model is required with --final");
      }
      const model = explicitModel || SPARK_MODEL;
      if (!finalMeasurement && model !== SPARK_MODEL) {
        throw new Error(
          `Development runs are locked to ${SPARK_MODEL}. Use an explicit --final command only after Spark evaluation.`,
        );
      }
      const effort = required(parsed.values.effort, "--effort");
      if (effort !== "medium") {
        throw new Error("--effort must be medium for a fair paired comparison");
      }
      const timeoutSeconds = Number(parsed.values.timeout);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3_600) {
        throw new Error("--timeout must be an integer from 1 to 3600 seconds");
      }
      const resultsRoot = resolve(parsed.values.results ?? join(benchRoot, "results"));
      if (finalMeasurement) await requireEvaluatedSparkPair(resultsRoot, scenario);
      const evidence = await runBenchmarkAttempt({
        projectRoot,
        benchRoot,
        resultsRoot,
        scenario,
        mode,
        measurement: finalMeasurement ? "final" : "development",
        model,
        effort,
        timeoutMs: timeoutSeconds * 1_000,
        codexCommand: await resolveCodexCommand(projectRoot),
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: evidence.run.runId,
            comparisonId: evidence.run.comparisonId,
            mode: evidence.run.mode,
            measurement: evidence.run.measurement ?? "development",
            outcome: evidence.run.outcome,
            evidencePath: evidence.path,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (command === "evaluate") {
      const runId = required(parsed.values.run, "--run");
      const resultsRoot = resolve(parsed.values.results ?? join(benchRoot, "results"));
      const evidence = await loadEvidencePackage(resultsRoot, runId);
      const document = await evaluateMutationEvidence(benchRoot, evidence);
      const analysis = await createOrVerifyAnalysisPackage(resultsRoot, evidence, document);
      process.stdout.write(
        `${JSON.stringify(
          {
            runId,
            analysisPath: analysis.path,
            analysis: analysis.document,
            manifest: analysis.manifest,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (command === "replay") {
      const runId = required(parsed.values.run, "--run");
      const resultsRoot = resolve(parsed.values.results ?? join(benchRoot, "results"));
      process.stdout.write(
        `${JSON.stringify(await replayBenchmarkRun(resultsRoot, runId), null, 2)}\n`,
      );
      return 0;
    }

    if (command === "report") {
      const resultsRoot = resolve(parsed.values.results ?? join(benchRoot, "results"));
      const report = await buildBenchmarkReport(resultsRoot);
      process.stdout.write(
        `${JSON.stringify(await writeBenchmarkReport(resultsRoot, report), null, 2)}\n`,
      );
      return 0;
    }
    throw new Error(`Unknown benchmark command: ${command}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function benchmarkMode(value: string): BenchmarkMode {
  if (value === "direct" || value === "changesafely") return value;
  throw new Error("--mode must be direct or changesafely");
}

function required(value: string | undefined, option: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${option} is required`);
  return result;
}

async function requireEvaluatedSparkPair(resultsRoot: string, scenario: string): Promise<void> {
  try {
    const report = await buildBenchmarkReport(resultsRoot);
    if (
      report.comparisons.some(
        (comparison) =>
          comparison.scenario === scenario &&
          comparison.model === SPARK_MODEL &&
          comparison.measurement === "development" &&
          comparison.paired,
      )
    ) {
      return;
    }
  } catch {
    // Report loading is fail-closed below so the user gets one stable gate message.
  }
  throw new Error(
    `--final requires an evaluated paired ${SPARK_MODEL} comparison for scenario ${scenario}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
