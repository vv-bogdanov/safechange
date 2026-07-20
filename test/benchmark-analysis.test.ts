import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createOrVerifyAnalysisPackage,
  evaluateMutationEvidence,
  loadAnalysisPackage,
} from "../bench/src/analysis.js";
import { createEvidencePackage } from "../bench/src/evidence.js";
import { buildBenchmarkReport, type RunCaseCard, replayBenchmarkRun } from "../bench/src/report.js";
import {
  materializeAttempt,
  scenarioDefinition,
  snapshotAttempt,
} from "../bench/src/repository.js";
import { ARTIFACT_VERSION } from "../src/schemas.js";
import { validHarness } from "./support/artifacts.js";
import { benchmarkComparisonContent, benchmarkRunDocument } from "./support/benchmark.js";

const projectRoot = process.cwd();
const benchRoot = join(projectRoot, "bench");
const execFileAsync = promisify(execFile);

test("evaluates candidate tests against reference and mutants, then replays one stable report", {
  timeout: 300_000,
}, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-analysis-test-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const scenario = scenarioDefinition(benchRoot, "double-charge");
  const attempt = await materializeAttempt(scenario, join(temporaryRoot, "candidate"));
  await writeFile(
    join(attempt.workspace, "test", "candidate-mutation.test.ts"),
    candidateMutationTest,
  );
  const snapshot = await snapshotAttempt(attempt.workspace, attempt.baselineCommit);
  const run = benchmarkRunDocument("mutation-run", {
    baselineCommit: attempt.baselineCommit,
    mode: "changesafely",
    scenarioVersion: scenario.version,
    snapshotCommit: snapshot.snapshotCommit,
    taskText: await readFile(scenario.task, "utf8"),
  });
  const resultsRoot = join(temporaryRoot, "results");
  const evidence = await createEvidencePackage(resultsRoot, run, {
    "comparison.json": benchmarkComparisonContent(run),
    "diff.patch": snapshot.diff,
    "events.jsonl": '{"type":"synthetic"}\n',
    "changesafely/outcome.json": `${JSON.stringify({
      runId: run.runId,
      status: "FAILED",
      reason: "Synthetic product rejection",
      nextAction: "Inspect evidence",
    })}\n`,
    "changesafely/run/harness.json": `${JSON.stringify(
      {
        meta: {
          artifactVersion: ARTIFACT_VERSION,
          producerVersion: "0.1.0",
          runId: run.runId,
          baselineCommit: run.baselineCommit,
          role: "test-author",
          createdAt: "2026-07-19T00:00:00.000Z",
          inputs: {},
        },
        payload: {
          ...validHarness({
            summary: "Synthetic protected harness",
            testPaths: ["test/candidate-mutation.test.ts"],
            protectedPaths: ["test/candidate-mutation.test.ts"],
          }),
          protectedHashes: { "test/candidate-mutation.test.ts": "f".repeat(64) },
          testCommit: run.snapshotCommit,
        },
      },
      null,
      2,
    )}\n`,
    "evaluation.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        scenario: "double-charge",
        checks: [{ id: "synthetic", category: "visible", passed: true, detail: "passed" }],
        summary: { visible: true, acceptance: true, preservation: true, scope: true },
        passed: true,
      },
      null,
      2,
    )}\n`,
  });

  const document = await evaluateMutationEvidence(benchRoot, evidence);
  assert.equal(document.reference.passed, true, JSON.stringify(document.reference.process));
  assert.deepEqual(
    document.mutants.map((mutant) => [mutant.id, mutant.killed]),
    [
      ["process-local-cache", true],
      ["check-then-write", true],
      ["receipt-without-validation", false],
      ["input-derived-key", false],
      ["precommitted-placeholder", false],
      ["constant-provider-key", false],
      ["in-flight-only", false],
    ],
  );
  assert.equal(document.mutation.killRate, 2 / 7);
  assert.deepEqual(document.candidateTests.paths, ["test/candidate-mutation.test.ts"]);
  assert.equal(document.protectedTests.applicable, true);
  assert.equal(document.protectedTests.intact, false);

  const analysis = await createOrVerifyAnalysisPackage(resultsRoot, evidence, document);
  assert.deepEqual(
    (await loadAnalysisPackage(resultsRoot, run.runId, evidence)).document,
    document,
  );
  const evaluated = await benchmarkCli<{ manifest: { analysisSha256: string } }>([
    "evaluate",
    "--run",
    run.runId,
    "--results",
    resultsRoot,
  ]);
  assert.equal(evaluated.manifest.analysisSha256, analysis.manifest.analysisSha256);
  const replay = await benchmarkCli<{ verified: boolean; caseCard: RunCaseCard | null }>([
    "replay",
    "--run",
    run.runId,
    "--results",
    resultsRoot,
  ]);
  assert.equal(replay.verified, true);
  assert.equal(replay.caseCard?.mutation?.killRate, 2 / 7);
  assert.equal(replay.caseCard?.productStatus, "FAILED");
  assert.ok((replay.caseCard?.diff?.testAdditions ?? 0) > 0);
  assert.equal(replay.caseCard?.diff?.productionFiles, 0);

  const reportOutput = await benchmarkCli<{ jsonPath: string; markdownPath: string }>([
    "report",
    "--results",
    resultsRoot,
  ]);
  const report = JSON.parse(await readFile(reportOutput.jsonPath, "utf8"));
  assert.deepEqual(report.comparisons[0]?.runs[0], replay.caseCard);
  assert.match(await readFile(reportOutput.markdownPath, "utf8"), /2\/7 \(29%\)/u);

  const analysisManifestPath = join(analysis.path, "analysis-manifest.json");
  const analysisManifest = await readFile(analysisManifestPath, "utf8");
  await rm(analysisManifestPath);
  await assert.rejects(
    benchmarkCli(["replay", "--run", run.runId, "--results", resultsRoot]),
    /package file set is invalid/u,
  );
  await writeFile(analysisManifestPath, analysisManifest);
  await writeFile(join(analysis.path, "analysis.json"), "{}\n");
  await assert.rejects(
    loadAnalysisPackage(resultsRoot, run.runId, evidence),
    /analysis document|hash/u,
  );
});

test("reports verified attempts whose versioned mutation analysis is unavailable", async (t) => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-unanalysed-report-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  const run = benchmarkRunDocument("unanalysed-run", { outcome: "technical_failure" });
  await createEvidencePackage(resultsRoot, run, {
    "comparison.json": benchmarkComparisonContent(run),
    "diff.patch": "",
    "events.jsonl": '{"type":"synthetic"}\n',
  });

  const replay = await replayBenchmarkRun(resultsRoot, run.runId);
  assert.equal(replay.verified, true);
  assert.equal(replay.analysis, null);
  assert.equal(replay.caseCard.analysisSha256, null);
  assert.equal(replay.caseCard.mutation, null);
  assert.equal(replay.caseCard.diff, null);

  const report = await buildBenchmarkReport(resultsRoot);
  assert.equal(report.comparisons[0]?.runs[0]?.outcome, "technical_failure");
  assert.equal(report.comparisons[0]?.runs[0]?.candidateTests, null);
});

test("reports blocked ChangeSafely status separately from unsafe candidate snapshot", async (t) => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-blocked-report-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  const run = benchmarkRunDocument("blocked-run", {
    mode: "changesafely",
    outcome: "unsafe_green",
  });
  await createEvidencePackage(resultsRoot, run, {
    "comparison.json": benchmarkComparisonContent(run),
    "diff.patch": "",
    "events.jsonl": '{"type":"synthetic"}\n',
    "changesafely/outcome.json": `${JSON.stringify({
      runId: run.runId,
      status: "BLOCKED",
      reason: "Synthetic safe stop before planning.",
      nextAction: "Resolve the contract uncertainty.",
    })}\n`,
    "evaluation.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        scenario: "double-charge",
        checks: [{ id: "synthetic", category: "visible", passed: true, detail: "passed" }],
        summary: { visible: true, acceptance: false, preservation: true, scope: true },
        passed: false,
      },
      null,
      2,
    )}\n`,
  });

  const replay = await replayBenchmarkRun(resultsRoot, run.runId);
  assert.equal(replay.caseCard.outcome, "unsafe_green");
  assert.equal(replay.caseCard.unsafeGreen, true);
  assert.equal(replay.caseCard.safeTaskSuccess, false);
  assert.equal(replay.caseCard.productStatus, "BLOCKED");

  const report = await buildBenchmarkReport(resultsRoot);
  const caseCard = report.comparisons[0]?.runs[0];
  assert.equal(caseCard?.outcome, "unsafe_green");
  assert.equal(caseCard?.productStatus, "BLOCKED");
});

async function benchmarkCli<Value>(args: string[]): Promise<Value> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(projectRoot, "dist", "bench", "src", "cli.js"), ...args],
    { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Value;
}

const candidateMutationTest = `import assert from "node:assert/strict";
import test from "node:test";
import {
  PaymentService,
  type GatewayChargeRequest,
  type OperationStore,
  type PaymentGateway,
  type PaymentReceipt,
  type RefundReceipt,
  type RefundRequest,
  type StoredOperation,
} from "../src/payment-service.js";

class MemoryStore implements OperationStore {
  readonly operations = new Map<string, StoredOperation>();
  async get(token: string) { return this.operations.get(token); }
  async save(operation: StoredOperation) { this.operations.set(operation.operationToken, operation); }
}

class AtomicGateway implements PaymentGateway {
  effects = 0;
  readonly payments = new Map<string, Promise<PaymentReceipt>>();
  async charge(input: GatewayChargeRequest): Promise<PaymentReceipt> {
    if (!input.idempotencyKey) return await this.create(input);
    const existing = this.payments.get(input.idempotencyKey);
    if (existing) return await existing;
    const payment = this.create(input);
    this.payments.set(input.idempotencyKey, payment);
    return await payment;
  }
  async refund(_input: RefundRequest): Promise<RefundReceipt> { throw new Error("unused"); }
  private async create(input: GatewayChargeRequest): Promise<PaymentReceipt> {
    await new Promise((resolve) => setImmediate(resolve));
    this.effects += 1;
    return { paymentId: \`payment-\${this.effects}\`, amount: input.amount, currency: input.currency };
  }
}

test("concurrent retries have one gateway effect", async () => {
  const gateway = new AtomicGateway();
  const service = new PaymentService(gateway, new MemoryStore());
  const input = { operationToken: "same", amount: 1000, currency: "USD" } as const;
  const [first, second] = await Promise.all([service.retryPayment(input), service.retryPayment(input)]);
  assert.equal(first.paymentId, second.paymentId);
  assert.equal(gateway.effects, 1);
});
`;
