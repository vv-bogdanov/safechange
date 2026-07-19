import {
  COMPARISON_VERSION,
  EVIDENCE_VERSION,
  type RunDocument,
} from "../../bench/src/contracts.js";
import { contentSha256 } from "../../bench/src/evidence.js";

export function benchmarkRunDocument(
  runId: string,
  overrides: Partial<RunDocument> = {},
): RunDocument {
  const taskText = overrides.taskText ?? "Synthetic benchmark task\n";
  const run: RunDocument = {
    evidenceVersion: EVIDENCE_VERSION,
    runId,
    comparisonId: "comparison-0123456789abcdef",
    comparisonSha256: "0".repeat(64),
    scenario: "double-charge",
    mode: "direct",
    measurement: "development",
    taskText,
    taskSha256: contentSha256(taskText),
    baselineCommit: "a".repeat(40),
    snapshotCommit: "b".repeat(40),
    model: "test-model",
    effort: "medium",
    environment: {
      nodeVersion: process.version,
      gitVersion: "git version test",
      codexVersion: "codex-cli test",
      changesafelyVersion: "0.1.0",
      platform: process.platform,
      architecture: process.arch,
    },
    isolation: {
      provider: "codex-permission-profile",
      permissionProfile: "changesafely-benchmark",
      canarySha256: "c".repeat(64),
      agentToolNetwork: "disabled",
    },
    worker: {
      startedAt: "2026-07-19T00:00:00.000Z",
      completedAt: "2026-07-19T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      signal: null,
      timedOut: false,
    },
    usage: {
      turns: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
    },
    outcome: "safe_success",
    ...overrides,
  };
  run.taskSha256 = contentSha256(run.taskText);
  run.comparisonSha256 = contentSha256(benchmarkComparisonContent(run));
  return run;
}

export function benchmarkComparisonContent(run: RunDocument): string {
  return `${JSON.stringify(
    {
      comparisonVersion: COMPARISON_VERSION,
      comparisonId: run.comparisonId,
      createdAt: "2026-07-19T00:00:00.000Z",
      measurement: run.measurement ?? "development",
      scenario: run.scenario,
      taskText: run.taskText,
      taskSha256: run.taskSha256,
      baselineCommit: run.baselineCommit,
      model: run.model,
      effort: run.effort,
      timeoutMs: 3_600_000,
      permissionProfile: run.isolation.permissionProfile,
      agentToolNetwork: "disabled",
      visibleChecks: ["npm test"],
      evaluatorSha256: "e".repeat(64),
      executionOrder: ["direct", "changesafely"],
      maxAttemptsPerMode: 1,
      environment: run.environment,
    },
    null,
    2,
  )}\n`;
}
