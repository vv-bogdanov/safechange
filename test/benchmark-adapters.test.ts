import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { contentSha256 } from "../bench/src/evidence.js";
import { runProcess } from "../bench/src/process.js";
import { runBenchmarkAttempt } from "../bench/src/run.js";

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
});

test("benchmark environment identifies the exact ChangeSafely commit", async () => {
  const environment = await collectEnvironmentVersions(process.execPath, process.cwd());
  assert.match(environment.changesafelyCommit, /^[a-f0-9]{40,64}$/u);
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
  assert.equal(direct.run.scenarioVersion, 2);
  assert.equal(changesafely.run.scenarioVersion, 2);
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
    visibleChecks: ["npm test"],
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
    },
  };
}
