import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { classifyTechnicalFailure } from "../bench/src/controller.js";
import {
  contentSha256,
  createEvidencePackage,
  loadEvidencePackage,
  readVerifiedEvidenceFile,
} from "../bench/src/evidence.js";
import { prepareCodexHome } from "../bench/src/isolation.js";
import {
  listScenarioDefinitions,
  materializeAttempt,
  repositoryCommand,
  scenarioDefinition,
  snapshotAttempt,
} from "../bench/src/repository.js";
import {
  benchmarkComparisonContent,
  benchmarkLegacyComparisonContent,
  benchmarkRunDocument,
} from "./support/benchmark.js";

const projectRoot = process.cwd();
const benchRoot = join(projectRoot, "bench");
const execFileAsync = promisify(execFile);

test("materializes an isolated Git baseline and snapshots only source evidence", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-repo-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const scenario = scenarioDefinition(benchRoot, "double-charge");
  const attempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace"));
  const secondAttempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace-2"));

  await writeFile(
    join(attempt.workspace, "src", "candidate.ts"),
    "export const candidate = true;\n",
  );
  await mkdir(join(attempt.workspace, "dist"));
  await writeFile(join(attempt.workspace, "dist", "ignored.js"), "ignored\n");
  const snapshot = await snapshotAttempt(attempt.workspace, attempt.baselineCommit);

  assert.match(attempt.baselineCommit, /^[a-f0-9]{40,64}$/u);
  assert.equal(secondAttempt.baselineCommit, attempt.baselineCommit);
  assert.match(snapshot.snapshotCommit, /^[a-f0-9]{40,64}$/u);
  assert.deepEqual(snapshot.changedFiles, ["src/candidate.ts"]);
  assert.match(snapshot.diff, /candidate = true/u);
  assert.doesNotMatch(snapshot.diff, /ignored\.js/u);
  assert.equal(scenario.version, 3);
  assert.equal(scenarioDefinition(benchRoot, "tenant-leak").version, 3);
  assert.equal(scenarioDefinition(benchRoot, "restart-storm").version, 3);
  assert.equal(scenarioDefinition(benchRoot, "legacy-spaghetti").version, 3);
  assert.deepEqual(
    listScenarioDefinitions(benchRoot).map(({ id }) => id),
    ["double-charge", "legacy-spaghetti", "partial-replay", "restart-storm", "tenant-leak"],
  );
  assert.throws(
    () => scenarioDefinition(benchRoot, "double-charge", 2),
    /scenario double-charge v2 is unavailable/u,
  );
});

test("discovers and prepares a non-npm scenario from its checked manifest", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-manifest-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const customBenchRoot = join(temporaryRoot, "bench");
  const scenarioRoot = join(customBenchRoot, "scenarios", "custom-runtime");
  const baseline = join(scenarioRoot, "baseline");
  const oracle = join(customBenchRoot, "oracles", "custom-runtime");
  await Promise.all([
    mkdir(join(baseline, "scripts"), { recursive: true }),
    mkdir(join(baseline, "specs"), { recursive: true }),
    mkdir(join(oracle, "mutants"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(baseline, ".gitignore"), "prepared.txt\n"),
    writeFile(
      join(baseline, "scripts", "prepare.mjs"),
      'import { writeFileSync } from "node:fs"; writeFileSync("prepared.txt", "ready\\n");\n',
    ),
    writeFile(
      join(baseline, "scripts", "check.mjs"),
      'import { readFileSync } from "node:fs"; if (readFileSync("prepared.txt", "utf8") !== "ready\\n") process.exit(1);\n',
    ),
    writeFile(join(baseline, "specs", "sample_check.js"), "// scenario test path\n"),
    writeFile(join(scenarioRoot, "task.txt"), "Exercise the custom runtime.\n"),
    writeFile(join(scenarioRoot, "validate.mjs"), "// test fixture validator\n"),
    writeFile(join(oracle, "evaluate.mjs"), "// test fixture evaluator\n"),
    writeFile(join(oracle, "reference.patch"), ""),
    writeFile(join(oracle, "mutants", "manifest.json"), '{"mutants":[]}\n'),
    writeFile(
      join(scenarioRoot, "scenario.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "custom-runtime",
          version: 1,
          visibleChecks: [{ argv: ["node", "scripts/check.mjs"], cwd: "." }],
          preparation: [
            {
              argv: ["node", "scripts/prepare.mjs"],
              cwd: ".",
              network: "disabled",
            },
          ],
          testPaths: { prefixes: ["specs"], patterns: ["*_check.js"] },
          toolchains: [{ id: "node", version: { argv: ["node", "--version"], cwd: "." } }],
        },
        null,
        2,
      )}\n`,
    ),
  ]);

  const [scenario] = listScenarioDefinitions(customBenchRoot);
  assert.equal(scenario?.id, "custom-runtime");
  assert.deepEqual(scenario?.visibleChecks, [{ argv: ["node", "scripts/check.mjs"], cwd: "." }]);
  const attempt = await materializeAttempt(
    scenarioDefinition(customBenchRoot, "custom-runtime"),
    join(temporaryRoot, "workspace"),
  );
  assert.equal(await readFile(join(attempt.workspace, "prepared.txt"), "utf8"), "ready\n");
  await repositoryCommand("node", ["scripts/check.mjs"], attempt.workspace);
  assert.equal(await repositoryCommand("git", ["status", "--porcelain"], attempt.workspace), "");
  await writeFile(
    join(baseline, "scripts", "prepare.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync("dirty.txt", "unexpected\\n");\n',
  );
  await assert.rejects(
    materializeAttempt(
      scenarioDefinition(customBenchRoot, "custom-runtime"),
      join(temporaryRoot, "dirty-workspace"),
    ),
    /preparation changed source-controlled state/u,
  );
});

test("scope evaluation sees forbidden files after the controller snapshot commit", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-scope-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const scenario = scenarioDefinition(benchRoot, "double-charge");
  const attempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace"));
  await writeFile(join(attempt.workspace, "README.md"), "forbidden benchmark change\n");
  await snapshotAttempt(attempt.workspace, attempt.baselineCommit);

  const { stdout } = await execFileAsync(
    process.execPath,
    [scenario.evaluator, attempt.workspace],
    {
      timeout: 180_000,
    },
  );
  const evaluation = JSON.parse(stdout) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };
  const forbidden = evaluation.checks.find((check) => check.id === "forbidden-files");
  assert.equal(forbidden?.passed, false);
  assert.match(forbidden?.detail ?? "", /README\.md/u);
});

test("creates immutable hash-verified evidence and fails closed on corruption", async (t) => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-evidence-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  const run = benchmarkRunDocument("evidence-run");
  const created = await createEvidencePackage(resultsRoot, run, {
    "comparison.json": benchmarkComparisonContent(run),
    "diff.patch": "diff --git a/a b/a\n",
    "events.jsonl": '{"type":"synthetic"}\n',
  });

  const verified = await loadEvidencePackage(resultsRoot, run.runId);
  assert.equal(verified.run.taskSha256, contentSha256(run.taskText));
  assert.equal(
    (await readVerifiedEvidenceFile(verified, "events.jsonl")).toString(),
    '{"type":"synthetic"}\n',
  );
  const { stdout: replayOutput } = await execFileAsync(
    process.execPath,
    [
      join(projectRoot, "dist/bench/src/cli.js"),
      "replay",
      "--run",
      run.runId,
      "--results",
      resultsRoot,
    ],
    { timeout: 10_000 },
  );
  assert.equal(JSON.parse(replayOutput).verified, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(created.path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(created.path, "run.json"))).mode & 0o777, 0o600);
  }
  await assert.rejects(
    createEvidencePackage(resultsRoot, run, {
      "comparison.json": benchmarkComparisonContent(run),
      "diff.patch": "",
      "events.jsonl": "",
    }),
    /already exists/u,
  );

  await writeFile(join(created.path, "diff.patch"), "tampered\n");
  await assert.rejects(loadEvidencePackage(resultsRoot, run.runId), /hash mismatch/u);
});

test("reads legacy v1 evidence without an explicit scenario version", async (t) => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-legacy-version-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  const run = benchmarkRunDocument("legacy-version-run");
  delete run.scenarioVersion;
  delete run.environment.toolchains;
  run.comparisonSha256 = contentSha256(benchmarkLegacyComparisonContent(run));
  await createEvidencePackage(resultsRoot, run, {
    "comparison.json": benchmarkLegacyComparisonContent(run),
    "diff.patch": "",
    "events.jsonl": '{"type":"synthetic"}\n',
  });

  const verified = await loadEvidencePackage(resultsRoot, run.runId);
  assert.equal(verified.run.scenarioVersion, undefined);
});

test("rejects extra evidence and path traversal", async (t) => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-extra-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  const run = benchmarkRunDocument("extra-run");
  const created = await createEvidencePackage(resultsRoot, run, {
    "comparison.json": benchmarkComparisonContent(run),
    "diff.patch": "",
    "events.jsonl": "",
  });
  await writeFile(join(created.path, "unexpected.txt"), "extra\n");
  await assert.rejects(loadEvidencePackage(resultsRoot, run.runId), /file set/u);

  await assert.rejects(
    createEvidencePackage(resultsRoot, benchmarkRunDocument("traversal-run"), {
      "../escape": "bad",
      "comparison.json": benchmarkComparisonContent(benchmarkRunDocument("traversal-run")),
      "diff.patch": "",
      "events.jsonl": "",
    }),
    /Invalid evidence path/u,
  );
});

test("builds a minimal Codex home with a deny-network permission profile", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-codex-home-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const source = join(temporaryRoot, "source");
  const destination = join(temporaryRoot, "destination");
  await mkdir(source);
  await writeFile(join(source, "auth.json"), '{"fake":"credential"}\n');
  await prepareCodexHome(source, destination, "changesafely-benchmark", "/runtime/node");
  const config = await readFile(join(destination, "config.toml"), "utf8");
  assert.match(config, /default_permissions = "changesafely-benchmark"/u);
  assert.match(config, /enabled = false/u);
  assert.match(config, /"\/runtime\/node" = "read"/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(destination, "auth.json"))).mode & 0o777, 0o600);
  }
});

test("classifies incomplete worker evidence as technical failure", () => {
  const complete = {
    started: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputPresent: true,
    eventsValid: true,
  };
  assert.equal(classifyTechnicalFailure(complete), undefined);
  assert.equal(
    classifyTechnicalFailure({ ...complete, started: false })?.reason,
    "process_not_started",
  );
  assert.equal(classifyTechnicalFailure({ ...complete, timedOut: true })?.reason, "timeout");
  assert.equal(
    classifyTechnicalFailure({ ...complete, signal: "SIGTERM" })?.reason,
    "process_signaled",
  );
  assert.equal(classifyTechnicalFailure({ ...complete, exitCode: 1 })?.reason, "process_failed");
  assert.equal(
    classifyTechnicalFailure({ ...complete, outputPresent: false })?.reason,
    "missing_output",
  );
  assert.equal(
    classifyTechnicalFailure({ ...complete, eventsValid: false })?.reason,
    "events_invalid",
  );
});

test("benchmark CLI requires an explicit final flag and an evaluated Spark pair", async (t) => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        join(projectRoot, "dist/bench/src/cli.js"),
        "run",
        "--scenario",
        "double-charge",
        "--mode",
        "direct",
        "--model",
        "gpt-5.6-codex",
      ],
      { timeout: 10_000 },
    ),
    (error: unknown) => {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      assert.match(stderr, /Use an explicit --final command only after Spark evaluation/u);
      return true;
    },
  );

  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-final-gate-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        join(projectRoot, "dist/bench/src/cli.js"),
        "run",
        "--scenario",
        "double-charge",
        "--mode",
        "direct",
        "--final",
        "--results",
        resultsRoot,
      ],
      { timeout: 10_000 },
    ),
    (error: unknown) => {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      assert.match(stderr, /--model is required with --final/u);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        join(projectRoot, "dist/bench/src/cli.js"),
        "run",
        "--scenario",
        "double-charge",
        "--mode",
        "direct",
        "--model",
        "gpt-5.6-codex",
        "--final",
        "--results",
        resultsRoot,
      ],
      { timeout: 10_000 },
    ),
    (error: unknown) => {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      assert.match(stderr, /requires an evaluated paired .* comparison/u);
      return true;
    },
  );
});

test("benchmark CLI validates additional scenario references and unsafe-green mutants", async () => {
  const expectedMutants: Readonly<Record<string, number>> = {
    "partial-replay": 6,
    "tenant-leak": 9,
    "restart-storm": 7,
    "legacy-spaghetti": 8,
  };
  for (const scenario of Object.keys(expectedMutants)) {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(projectRoot, "dist/bench/src/cli.js"), "validate", "--scenario", scenario],
      { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as {
      passed: boolean;
      mutants: Array<{ outcome: string }>;
    };
    assert.equal(result.passed, true, scenario);
    assert.equal(result.mutants.length, expectedMutants[scenario], scenario);
    assert.ok(
      result.mutants.every((mutant) => mutant.outcome === "unsafe_green"),
      scenario,
    );
  }
});
