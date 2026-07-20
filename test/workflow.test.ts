import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PreflightError } from "../src/git.js";
import { runHarness } from "../src/harness.js";
import { runImplementationAndVerification } from "../src/implementation.js";
import { validateResumeBoundary } from "../src/orchestrator.js";
import {
  implementationReport,
  loadAssuranceProfile,
  renderAssuranceReport,
} from "../src/report.js";
import { REPOSITORY_CONFIG_PATH } from "../src/repository-capabilities.js";
import { loadTrace } from "../src/trace.js";
import { runPlanning } from "../src/workflow.js";
import { fakeAppServerFactory } from "./support/app-server.js";
import { createTestRepo, git, readRunState } from "./support/repository.js";

async function fixtureRepo(
  t: TestContext,
  testScript = "node --test",
  scripts: Record<string, string> = {},
  files: Record<string, string> = {},
): Promise<string> {
  return createTestRepo(t, {
    prefix: "changesafely-plan-",
    files: {
      "AGENTS.md": "# Fixture\n",
      "package.json": `${JSON.stringify({ name: "fixture", scripts: { test: testScript, ...scripts } }, null, 2)}\n`,
      "src/value.ts": "export const value = 1;\n",
      ...files,
    },
  });
}

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("runs D0 and C0 as roots and decision roles as C0 forks", async (t) => {
  const repoPath = await fixtureRepo(t);

  const result = await runPlanning({
    repoPath,
    task: "Add the requested fixture behavior without changing the public API.",
    plannerCount: 3,
    clientFactory: fakeAppServerFactory(repoPath, "out-of-order"),
    parallelPlanners: true,
  });

  assert.equal(result.status, "PLANNED");
  assert.equal(result.decision?.winnerPlanId, "plan-1");
  const state = await readRunState(result.runPath);
  assert.ok(state.repositoryCapabilities?.checks.some((check) => check.kind === "test"));
  assert.match(state.repositoryCapabilitiesSha256 ?? "", /^[a-f0-9]{64}$/u);
  const discovery = state.contexts.find((entry) => entry.role === "discovery");
  const contract = state.contexts.find((entry) => entry.role === "contract");
  assert.ok(discovery);
  assert.ok(contract);
  assert.notEqual(discovery.threadId, contract.threadId);
  assert.equal(discovery.parentThreadId, null);
  assert.equal(contract.parentThreadId, null);

  const decisionRoles = state.contexts.filter(
    (entry) => entry.role.startsWith("planner:") || entry.role === "judge",
  );
  assert.equal(decisionRoles.length, 4);
  for (const entry of decisionRoles) {
    assert.equal(entry.parentThreadId, contract.threadId);
    assert.equal(entry.checkpointTurnId, contract.turnId);
  }

  assert.equal(await git(repoPath, ["status", "--porcelain=v1", "--untracked-files=no"]), "");
  assert.match(await readFile(result.reportPath, "utf8"), /Selected `plan-1`/);
});

test("blocks before App Server work when tracked state is dirty", async (t) => {
  const repoPath = await fixtureRepo(t);
  await writeFile(join(repoPath, "src", "value.ts"), "export const value = 2;\n", "utf8");

  await assert.rejects(
    runPlanning({
      repoPath,
      task: "Change the value.",
      plannerCount: 1,
      clientFactory: () => {
        throw new Error("App Server must not start");
      },
    }),
    (error: unknown) =>
      error instanceof PreflightError && error.reasonCode === "DIRTY_TRACKED_STATE",
  );
});

test("blocks an unresolved critical contract before planners or a write branch", async (t) => {
  const repoPath = await fixtureRepo(t);
  const baselineBranch = await git(repoPath, ["branch", "--show-current"]);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value only if failure behavior is known.",
    plannerCount: 3,
    clientFactory: fakeAppServerFactory(repoPath, "critical-contract-unknown"),
  });

  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /UNRESOLVED_CRITICAL_CONTRACT_UNKNOWN/u);
  assert.doesNotMatch(result.reason, /VERIFIED/u);
  const state = await readRunState(result.runPath);
  assert.equal(state.phase, "planning-complete");
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.branch, "");
  assert.equal(state.artifacts.decision, undefined);
  assert.equal(
    state.contexts.some((entry) => entry.role.startsWith("planner:")),
    false,
  );
  assert.equal(await git(repoPath, ["branch", "--show-current"]), baselineBranch);
});

test("plans when contract models testable uncertainty as a critical risk", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value and prove the local failure boundary.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "testable-contract-risk"),
  });

  assert.equal(result.status, "PLANNED");
  const state = await readRunState(result.runPath);
  assert.ok(state.contexts.some((entry) => entry.role === "planner:plan-1"));
  assert.equal(state.branch, "");
});

test("carries testable contract risk into Test Author evidence", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "testable-contract-risk");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value and prove the local failure boundary.",
    plannerCount: 1,
    clientFactory,
  });

  const harness = await runHarness({ repoPath, runId: planning.runId, clientFactory });

  assert.equal(harness.harness.coverage.matrix.branches.relatedRiskIds.includes("R1"), true);
  const state = await readRunState(planning.runPath);
  assert.equal(state.phase, "harness-complete");
  assert.ok(state.contexts.some((entry) => entry.role === "planner:plan-1"));
  assert.ok(state.contexts.some((entry) => entry.role === "test-author:change"));
});

test("persists broad contract relationship graphs as traceable evidence", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value while preserving traceable risk boundaries.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "traceable-contract-graph"),
  });

  assert.equal(result.status, "PLANNED");
  const contract = JSON.parse(await readFile(join(result.runPath, "contract.json"), "utf8")) as {
    payload: {
      risks: Array<{ id: string; relatedIds: string[] }>;
      unknowns: Array<{ id: string; relatedIds: string[] }>;
      nonGoals: Array<{ id: string; relatedRiskIds: string[] }>;
    };
  };
  assert.deepEqual(contract.payload.risks[0]?.relatedIds, ["AC1", "INV1", "U1", "NG1"]);
  assert.deepEqual(contract.payload.unknowns[0]?.relatedIds, ["R1", "NG1"]);
  assert.deepEqual(contract.payload.nonGoals[0]?.relatedRiskIds, ["R1"]);
  const state = await readRunState(result.runPath);
  assert.ok(state.contexts.some((entry) => entry.role === "planner:plan-1"));
});

test("corrects one malformed contract schema in the same root before planners", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value after correcting the contract artifact.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "contract-schema-correction"),
  });

  assert.equal(result.status, "PLANNED");
  const state = await readRunState(result.runPath);
  const contract = state.contexts.find((entry) => entry.role === "contract");
  const correction = state.contexts.find((entry) => entry.role === "contract-correction");
  const planner = state.contexts.find((entry) => entry.role === "planner:plan-1");
  assert.ok(contract);
  assert.equal(correction?.threadId, contract.threadId);
  assert.equal(contract.turnId, correction?.turnId);
  assert.notEqual(correction?.checkpointTurnId, correction?.turnId);
  assert.equal(planner?.checkpointTurnId, correction?.turnId);
});

test("corrects one contract relationship artifact before planners", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value after fixing contract relationships.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "contract-correction"),
  });

  assert.equal(result.status, "PLANNED");
  const state = await readRunState(result.runPath);
  const correction = state.contexts.find((entry) => entry.role === "contract-correction");
  const planner = state.contexts.find((entry) => entry.role === "planner:plan-1");
  assert.ok(correction);
  assert.equal(planner?.checkpointTurnId, correction.turnId);
});

test("blocks when corrected contract retains an unresolved critical unknown", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value only if failure behavior is known.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "contract-correction-critical-retained"),
  });

  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /UNRESOLVED_CRITICAL_CONTRACT_UNKNOWN/u);
  const state = await readRunState(result.runPath);
  assert.ok(state.contexts.some((entry) => entry.role === "contract-correction"));
  assert.equal(
    state.contexts.some((entry) => entry.role.startsWith("planner:")),
    false,
  );
  assert.equal(state.branch, "");
});

test("blocks when contract correction removes a critical unknown", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value only if failure behavior is known.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "contract-correction-critical-downgrade"),
  });

  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /CONTRACT_CORRECTION_CHANGED_CRITICAL_UNKNOWN/u);
  const state = await readRunState(result.runPath);
  assert.ok(state.contexts.some((entry) => entry.role === "contract-correction"));
  assert.equal(
    state.contexts.some((entry) => entry.role.startsWith("planner:")),
    false,
  );
  assert.equal(state.branch, "");
});

test("corrects one planner artifact in the same fork before Judge", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "planner-correction"),
  });

  assert.equal(result.status, "PLANNED");
  const state = await readRunState(result.runPath);
  const planner = state.contexts.find((entry) => entry.role === "planner:plan-1");
  const correction = state.contexts.find((entry) => entry.role === "planner-correction:plan-1");
  assert.equal(correction?.threadId, planner?.threadId);
  assert.equal(correction?.checkpointTurnId, planner?.turnId);
});

test("corrects one Judge decision in the same fork before planning completes", async (t) => {
  const repoPath = await fixtureRepo(t);
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "judge-correction"),
  });

  assert.equal(result.status, "PLANNED");
  const state = await readRunState(result.runPath);
  const judge = state.contexts.find((entry) => entry.role === "judge");
  const correction = state.contexts.find((entry) => entry.role === "judge-correction");
  assert.equal(correction?.threadId, judge?.threadId);
  assert.equal(correction?.checkpointTurnId, judge?.turnId);
});

test("commits separate baseline-green C1 and baseline-red T1 harnesses", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath);
  const baseline = await git(repoPath, ["rev-parse", "HEAD"]);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 3,
    clientFactory,
  });

  const harness = await runHarness({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.match(harness.branch, /^changesafely\//);
  assert.equal(harness.command.exitCode, 1);
  assert.deepEqual(Object.keys(harness.protectedHashes), [
    "test/value.characterization.test.ts",
    "test/value.test.ts",
  ]);
  assert.equal(
    await git(repoPath, ["diff", "--name-only", baseline, harness.characterizationCommit]),
    "test/value.characterization.test.ts",
  );
  assert.equal(
    await git(repoPath, [
      "diff",
      "--name-only",
      harness.characterizationCommit,
      harness.testCommit,
    ]),
    "test/value.test.ts",
  );
  const log = await git(repoPath, ["log", "--format=%s", "--reverse"]);
  assert.deepEqual(log.split("\n"), [
    "fixture baseline",
    "test: add ChangeSafely characterization harness",
    "test: add ChangeSafely change harness",
  ]);
  const state = await readRunState(planning.runPath);
  assert.equal(state.characterizationCommit, harness.characterizationCommit);
  assert.equal(state.testCommit, harness.testCommit);
  assert.equal(state.phase, "harness-complete");
  const contract = state.contexts.find((entry) => entry.role === "contract");
  const characterization = state.contexts.find(
    (entry) => entry.role === "test-author:characterization",
  );
  const change = state.contexts.find((entry) => entry.role === "test-author:change");
  const reviewContext = state.contexts.find((entry) => entry.role === "verifier:harness:1");
  assert.equal(characterization?.parentThreadId, contract?.threadId);
  assert.equal(change?.threadId, characterization?.threadId);
  assert.equal(change?.checkpointTurnId, characterization?.turnId);
  assert.equal(reviewContext?.parentThreadId, contract?.threadId);
  assert.equal(reviewContext?.checkpointTurnId, contract?.turnId);
  assert.notEqual(reviewContext?.threadId, change?.threadId);
  assert.equal(state.harnessCorrectionCount, 0);
  const review = JSON.parse(
    await readFile(join(planning.runPath, "harness-review.json"), "utf8"),
  ) as { payload: { accepted: boolean; attempts: unknown[]; corrections: unknown[] } };
  assert.equal(review.payload.accepted, true);
  assert.equal(review.payload.attempts.length, 1);
  assert.equal(review.payload.corrections.length, 0);
  const c1Commands = JSON.parse(
    await readFile(join(planning.runPath, "characterization-commands.json"), "utf8"),
  ) as { payload: Array<{ exitCode: number }> };
  assert.equal(c1Commands.payload[0]?.exitCode, 0);
});

test("blocks a missing critical risk mapping before Implementer", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "missing-risk-mapping");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value only with executable evidence for every critical risk.",
    plannerCount: 1,
    clientFactory,
  });

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    /MISSING_HARNESS_CRITICAL_RISK/u,
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.phase, "test-author-failed");
  assert.equal(
    state.contexts.some((context) => context.role === "implementer"),
    false,
  );
});

test("lets the same Test Author append one bounded correction before review acceptance", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "harness-correction");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value with independently reviewed edge evidence.",
    plannerCount: 1,
    clientFactory,
  });

  const harness = await runHarness({ repoPath, runId: planning.runId, clientFactory });
  const state = await readRunState(planning.runPath);
  const review = JSON.parse(
    await readFile(join(planning.runPath, "harness-review.json"), "utf8"),
  ) as {
    payload: {
      accepted: boolean;
      attempts: Array<{ verdict: string }>;
      corrections: Array<{ commit: string; changedPaths: string[] }>;
    };
  };

  assert.equal(state.harnessCorrectionCount, 1);
  assert.equal(review.payload.accepted, true);
  assert.deepEqual(
    review.payload.attempts.map((attempt) => attempt.verdict),
    ["reject", "accept"],
  );
  assert.deepEqual(review.payload.corrections[0]?.changedPaths, ["test/value.harness-1.test.ts"]);
  assert.ok(harness.protectedHashes["test/value.test.ts"]);
  assert.ok(harness.protectedHashes["test/value.harness-1.test.ts"]);
  const changeAuthor = state.contexts.find((entry) => entry.role === "test-author:change");
  const correction = state.contexts.find((entry) => entry.role === "test-author:correction:1");
  const reviews = state.contexts.filter((entry) => entry.role.startsWith("verifier:harness:"));
  assert.equal(correction?.threadId, changeAuthor?.threadId);
  assert.equal(correction?.checkpointTurnId, changeAuthor?.turnId);
  assert.equal(reviews.length, 2);
  assert.notEqual(reviews[0]?.threadId, reviews[1]?.threadId);
  assert.deepEqual((await git(repoPath, ["log", "--format=%s", "--reverse"])).split("\n"), [
    "fixture baseline",
    "test: add ChangeSafely characterization harness",
    "test: add ChangeSafely change harness",
    "test: strengthen ChangeSafely harness (1)",
  ]);
});

test("blocks an over-constrained harness after two corrections without starting Implementer", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "overconstrained-harness");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value using only grounded semantics.",
    plannerCount: 1,
    clientFactory,
  });

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INSUFFICIENT_VERIFICATION_ENVIRONMENT" &&
      /unsupported value/iu.test(error.message),
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.phase, "test-author-failed");
  assert.equal(state.harnessCorrectionCount, 2);
  assert.equal(state.artifacts.harnessReview, undefined);
  assert.equal(
    state.contexts.some((entry) => entry.role === "implementer"),
    false,
  );
  assert.equal(
    state.contexts.filter((entry) => entry.role.startsWith("verifier:harness:")).length,
    3,
  );
  assert.match(await readFile(join(repoPath, "test", "value.test.ts"), "utf8"), /value, 3/u);
  assert.deepEqual((await git(repoPath, ["log", "--format=%s", "--reverse"])).split("\n"), [
    "fixture baseline",
    "test: add ChangeSafely characterization harness",
    "test: add ChangeSafely change harness",
    "test: strengthen ChangeSafely harness (1)",
    "test: strengthen ChangeSafely harness (2)",
  ]);
});

test("does not persist accepted harness artifacts for an inconsistent H1 result", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "harness-invalid-accept");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value only after a traceable harness review.",
    plannerCount: 1,
    clientFactory,
  });

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "HARNESS_REVIEW_INVALID",
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.artifacts.harness, undefined);
  assert.equal(state.artifacts.commands, undefined);
  assert.equal(state.artifacts.harnessReview, undefined);
  await assert.rejects(access(join(planning.runPath, "harness.json")));
  await assert.rejects(access(join(planning.runPath, "commands.json")));
  await assert.rejects(access(join(planning.runPath, "harness-review.json")));
});

test("refuses to start Implementer without the accepted harness review artifact", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value after independent harness review.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });
  const state = await readRunState(planning.runPath);
  delete state.artifacts.harnessReview;
  await writeFile(
    join(planning.runPath, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(
    runImplementationAndVerification({
      repoPath,
      runId: planning.runId,
      clientFactory: () => {
        throw new Error("Implementer App Server must not start");
      },
    }),
    /Artifact hash mismatch: harness-review\.json/u,
  );
});

test("uses C1 as the final protected harness for a pure refactor", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "refactor");
  const planning = await runPlanning({
    repoPath,
    task: "Refactor the fixture without changing observable behavior.",
    plannerCount: 1,
    clientFactory,
  });

  const harness = await runHarness({ repoPath, runId: planning.runId, clientFactory });
  assert.equal(harness.command.exitCode, 0);
  assert.equal(harness.characterizationCommit, harness.testCommit);
  const state = await readRunState(planning.runPath);
  assert.equal(
    state.contexts.some((entry) => entry.role === "test-author:change"),
    false,
  );

  const implementation = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });
  assert.equal(implementation.accepted, true);
  assert.deepEqual((await git(repoPath, ["log", "--format=%s", "--reverse"])).split("\n"), [
    "fixture baseline",
    "test: add ChangeSafely characterization harness",
    "feat: implement selected ChangeSafely plan",
  ]);
});

test("preserves and resumes C1 after an interrupted change-harness turn", async (t) => {
  const repoPath = await fixtureRepo(t);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath),
  });
  const controller = new AbortController();
  const interrupted = runHarness({
    repoPath,
    runId: planning.runId,
    signal: controller.signal,
    clientFactory: fakeAppServerFactory(repoPath, "delay-change", {
      signal: controller.signal,
    }),
  });
  await waitFor(join(repoPath, ".changesafely", "test-change-author-started"));
  controller.abort(new Error("test interruption"));
  await assert.rejects(interrupted, /test interruption|aborted/iu);

  const c1State = await readRunState(planning.runPath);
  assert.equal(c1State.phase, "characterization-complete");
  assert.equal(await git(repoPath, ["rev-parse", "HEAD"]), c1State.characterizationCommit);
  await validateResumeBoundary(repoPath, planning.runId);

  const resumed = await runHarness({
    repoPath,
    runId: planning.runId,
    clientFactory: fakeAppServerFactory(repoPath),
  });
  assert.notEqual(resumed.testCommit, resumed.characterizationCommit);
  assert.equal((await readRunState(planning.runPath)).phase, "harness-complete");
});

test("rejects production changes in C1 and rewrites of protected C1 during T1", async (t) => {
  for (const mode of ["characterization-production", "rewrite-characterization"]) {
    const repoPath = await fixtureRepo(t);
    const clientFactory = fakeAppServerFactory(repoPath, mode);
    const planning = await runPlanning({
      repoPath,
      task: "Change the fixture value.",
      plannerCount: 1,
      clientFactory,
    });

    await assert.rejects(
      runHarness({ repoPath, runId: planning.runId, clientFactory }),
      mode === "characterization-production" ? /outside test scope/u : /modified protected C1/u,
    );
    const state = await readRunState(planning.runPath);
    assert.equal(state.phase, "test-author-failed");
    assert.equal(state.testCommit, "");
  }
});

test("blocks an invalid invariant mapping before the characterization commit", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "invalid-harness-mapping");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory,
  });

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    /MISSING_HARNESS_INVARIANT/u,
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.phase, "test-author-failed");
  assert.equal(state.characterizationCommit, "");
  assert.equal(
    state.contexts.some((entry) => entry.role === "implementer"),
    false,
  );
});

test("accepts language-neutral nonempty failure output for a red harness", async (t) => {
  const testScript =
    "node -e \"const fs=require('node:fs'); const harness=fs.existsSync('test/value.test.ts'); const implemented=fs.readFileSync('src/value.ts','utf8').includes('= 2'); if(harness && !implemented){console.error('custom domain mismatch');process.exit(1)}\"";
  const repoPath = await fixtureRepo(t, testScript);
  const clientFactory = fakeAppServerFactory(repoPath);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory,
  });

  const harness = await runHarness({ repoPath, runId: planning.runId, clientFactory });
  assert.equal(harness.harness.expectedBaselineOutcome, "fail");
  const result = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });
  assert.equal(result.accepted, true);
});

test("stops when the baseline repository test script changes protected configuration", async (t) => {
  const repoPath = await fixtureRepo(
    t,
    `node -e "require('node:fs').writeFileSync('.env', 'changed')" && node --test`,
  );
  const clientFactory = fakeAppServerFactory(repoPath);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 1,
    clientFactory,
  });

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    /Protected configuration metadata changed/,
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.status, "FAILED");
  assert.equal(Boolean(state.testCommit), false);
});

test("creates I1, preserves T1, runs commands, and verifies from a fresh C0 fork", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 3,
    clientFactory,
  });
  const harness = await runHarness({ repoPath, runId: planning.runId, clientFactory });
  const protectedBefore = harness.protectedHashes["test/value.test.ts"];

  const implementation = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.equal(implementation.accepted, true);
  assert.equal(implementation.verification.verdict, "accept");
  assert.ok(implementation.commands.every((command) => command.exitCode === 0));
  const persistedCommands = JSON.parse(
    await readFile(join(planning.runPath, "verification-commands.json"), "utf8"),
  ) as { payload: Array<Record<string, unknown>> };
  for (const command of persistedCommands.payload) {
    assert.equal("stdout" in command, false);
    assert.equal("stderr" in command, false);
    assert.equal(command.cwd, ".");
    assert.ok(Array.isArray(command.argv));
    assert.match(String(command.stdoutSha256), /^[a-f0-9]{64}$/);
    assert.match(String(command.stderrSha256), /^[a-f0-9]{64}$/);
  }
  const state = await readRunState(planning.runPath);
  assert.equal(state.implementationCommit, implementation.implementationCommit);
  assert.equal(state.phase, "verification-complete");
  const profile = await loadAssuranceProfile(repoPath, state);
  const report = await readFile(join(planning.runPath, "report.md"), "utf8");
  assert.equal(report, await implementationReport(repoPath, state));
  assert.equal(report, renderAssuranceReport(profile));
  assert.equal(profile.commits.b0, state.baselineCommit);
  assert.equal(profile.commits.c1, state.characterizationCommit);
  assert.equal(profile.commits.t1, state.testCommit);
  assert.equal(profile.commits.i1, state.implementationCommit);
  assert.equal(profile.commits.r1, null);
  assert.ok(profile.traceability.every((claim) => claim.checkIds.length > 0));
  assert.ok(profile.commandGroups.flatMap((group) => group.commands).length >= 3);
  assert.ok(profile.analytics.roleTurns.length > 0);
  assert.match(report, /## Traceability/u);
  assert.match(report, /## Harness review H1/u);
  assert.match(report, /## Protected harness integrity/u);
  assert.match(report, /## Run analytics/u);
  assert.match(report, /not a claim of absolute safety/u);
  assert.match(report, /\[verification\.json\]\(verification\.json\)/u);
  assert.doesNotMatch(report, /"stdout"|"stderr"/u);
  const harnessArtifact = JSON.parse(
    await readFile(join(planning.runPath, "harness.json"), "utf8"),
  ) as { payload: { protectedHashes: Record<string, string> } };
  assert.equal(harnessArtifact.payload.protectedHashes["test/value.test.ts"], protectedBefore);
  assert.equal(
    await git(repoPath, ["diff", "--name-only", state.testCommit, state.implementationCommit]),
    "src/value.ts",
  );
  const contract = state.contexts.find((entry) => entry.role === "contract");
  const implementer = state.contexts.find((entry) => entry.role === "implementer");
  const verifier = state.contexts.find((entry) => entry.role === "verifier");
  assert.equal(implementer?.parentThreadId, contract?.threadId);
  assert.equal(verifier?.parentThreadId, contract?.threadId);
  assert.notEqual(verifier?.parentThreadId, implementer?.threadId);
  const log = await git(repoPath, ["log", "--format=%s", "--reverse"]);
  assert.deepEqual(log.split("\n"), [
    "fixture baseline",
    "test: add ChangeSafely characterization harness",
    "test: add ChangeSafely change harness",
    "feat: implement selected ChangeSafely plan",
  ]);
});

test("uses the Git diff when the Implementer omits a reported path", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "incomplete-implementation-artifact");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  const result = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.equal(result.accepted, true);
  const artifact = JSON.parse(
    await readFile(join(planning.runPath, "implementation.json"), "utf8"),
  ) as { payload: { changedPaths: string[]; actualPaths: string[] } };
  assert.deepEqual(artifact.payload.changedPaths, []);
  assert.deepEqual(artifact.payload.actualPaths, ["src/value.ts"]);
});

test("returns REPLAN_REQUIRED when no safe implementation can be written", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "implementer-replan");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value only if the selected contract supports it safely.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  await assert.rejects(
    runImplementationAndVerification({ repoPath, runId: planning.runId, clientFactory }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "IMPLEMENTATION_REPLAN_REQUIRED",
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.status, "REPLAN_REQUIRED");
  assert.equal(state.phase, "implementation-failed");
  assert.match(state.nextAction, /correcting the contract, harness, or selected scope/u);
  assert.equal(await git(repoPath, ["diff", "--name-only", state.testCommit]), "");
});

test("runs the selected plan verification commands without rediscovering package scripts", async (t) => {
  const repoPath = await fixtureRepo(t, "node --test", {
    "check:plan": 'node -e "process.exit(0)"',
  });
  const clientFactory = fakeAppServerFactory(repoPath, "plan-command");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value and use the selected verification command.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  const result = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.deepEqual(
    result.commands.map((command) => command.argv),
    [
      ["npm", "test"],
      ["npm", "run", "check:plan"],
    ],
  );
});

test("records registered numeric coverage at baseline and final boundaries", async (t) => {
  const marker = JSON.stringify({
    changesafelyCoverage: {
      schemaVersion: 1,
      scope: ["src/value.ts"],
      lines: { covered: 9, total: 10 },
      branches: { covered: 4, total: 5 },
    },
  });
  const repoPath = await fixtureRepo(
    t,
    "node --test",
    { "test:coverage": "node coverage.mjs" },
    { "coverage.mjs": `console.log(${JSON.stringify(marker)});\n` },
  );
  const clientFactory = fakeAppServerFactory(repoPath);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without reducing impacted coverage.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  const result = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });
  const baseline = JSON.parse(
    await readFile(join(planning.runPath, "coverage-baseline.json"), "utf8"),
  ) as { payload: { mode: string; lines: { percent: number }; commands: unknown[] } };
  const final = JSON.parse(
    await readFile(join(planning.runPath, "coverage-final.json"), "utf8"),
  ) as { payload: { mode: string; lines: { percent: number }; commands: unknown[] } };

  assert.equal(result.accepted, true);
  assert.equal(baseline.payload.mode, "numeric");
  assert.equal(final.payload.mode, "numeric");
  assert.equal(baseline.payload.lines.percent, 90);
  assert.equal(final.payload.lines.percent, 90);
  assert.equal(baseline.payload.commands.length, 1);
  assert.equal(final.payload.commands.length, 1);
  assert.equal(
    result.commands.some((command) => command.argv.includes("test:coverage")),
    false,
  );
});

test("blocks a scoped numeric coverage regression before Verifier", async (t) => {
  const repoPath = await fixtureRepo(
    t,
    "node --test",
    { "test:coverage": "node coverage.mjs" },
    {
      "coverage.mjs": `import { readFileSync } from "node:fs";
const changed = readFileSync("src/value.ts", "utf8").includes("value = 2");
console.log(JSON.stringify({ changesafelyCoverage: { schemaVersion: 1, scope: ["src/value.ts"], lines: { covered: changed ? 8 : 9, total: 10 }, branches: { covered: 4, total: 5 } } }));
`,
    },
  );
  const clientFactory = fakeAppServerFactory(repoPath);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without reducing impacted coverage.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  await assert.rejects(
    runImplementationAndVerification({ repoPath, runId: planning.runId, clientFactory }),
    /LINE_COVERAGE_REGRESSION/u,
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.phase, "implementation-failed");
  assert.equal(
    state.contexts.some((context) => context.role === "verifier"),
    false,
  );
  assert.equal(state.artifacts.coverageFinal, undefined);
});

test("rejects an accept verdict that retains findings or residual risks", async (t) => {
  for (const mode of ["verifier-warning", "verifier-residual-risk"]) {
    const repoPath = await fixtureRepo(t);
    const clientFactory = fakeAppServerFactory(repoPath, mode);
    const planning = await runPlanning({
      repoPath,
      task: "Change the fixture value with no unresolved high-risk evidence.",
      plannerCount: 1,
      clientFactory,
    });
    await runHarness({ repoPath, runId: planning.runId, clientFactory });

    const result = await runImplementationAndVerification({
      repoPath,
      runId: planning.runId,
      clientFactory,
    });
    const state = await readRunState(planning.runPath);
    assert.equal(result.accepted, false, mode);
    assert.equal(state.status, "FAILED", mode);
    assert.equal(state.repairCount, 0, mode);
    assert.match(
      await readFile(join(planning.runPath, "report.md"), "utf8"),
      /Assurance decision: rejected because the accept verdict retained/u,
      mode,
    );
  }
});

test("routes every upstream defect away from Implementer repair", async (t) => {
  const scenarios = [
    ["harness-defect-verifier", /Test Author/u],
    ["contract-defect-verifier", /contract or selected scope/u],
    ["scope-defect-verifier", /contract or selected scope/u],
    ["evidence-defect-verifier", /verification environment/u],
  ] as const;
  for (const [mode, nextAction] of scenarios) {
    const repoPath = await fixtureRepo(t);
    const clientFactory = fakeAppServerFactory(repoPath, mode);
    const planning = await runPlanning({
      repoPath,
      task: "Change the fixture value without repairing upstream defects in production.",
      plannerCount: 1,
      clientFactory,
    });
    await runHarness({ repoPath, runId: planning.runId, clientFactory });

    const result = await runImplementationAndVerification({
      repoPath,
      runId: planning.runId,
      clientFactory,
    });
    const state = await readRunState(planning.runPath);
    assert.equal(result.accepted, false, mode);
    assert.equal(state.repairCount, 0, mode);
    assert.match(state.nextAction, nextAction, mode);
    assert.equal(
      state.contexts.some((context) => context.role === "repair"),
      false,
      mode,
    );
  }
});

test("rejects a Repair change to the protected C1/T1 harness", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "repair-protected-edit");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without weakening evidence during repair.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  await assert.rejects(
    runImplementationAndVerification({ repoPath, runId: planning.runId, clientFactory }),
    /protected T1 path/u,
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.phase, "implementation-failed");
  assert.equal(state.repairCount, 1);
  assert.ok(state.contexts.some((context) => context.role === "repair"));
  assert.equal(state.artifacts.repair, undefined);
});

test("resumes the same Implementer once for a local repair and forks a fresh Verifier", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath, "repair");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 3,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  const result = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.equal(result.accepted, true);
  const state = await readRunState(planning.runPath);
  assert.equal(state.repairCount, 1);
  const implementer = state.contexts.find((entry) => entry.role === "implementer");
  const repair = state.contexts.find((entry) => entry.role === "repair");
  const verifiers = state.contexts.filter(
    (entry) => entry.role === "verifier" || entry.role === "verifier:repair",
  );
  assert.equal(repair?.threadId, implementer?.threadId);
  assert.equal(verifiers.length, 2);
  assert.notEqual(verifiers[0]?.threadId, verifiers[1]?.threadId);
  const log = await git(repoPath, ["log", "--format=%s", "--reverse"]);
  assert.deepEqual(log.split("\n"), [
    "fixture baseline",
    "test: add ChangeSafely characterization harness",
    "test: add ChangeSafely change harness",
    "feat: implement selected ChangeSafely plan",
    "fix: repair selected ChangeSafely implementation",
  ]);
});

test("refuses a planning resume when a persisted artifact hash changed", async (t) => {
  const repoPath = await fixtureRepo(t);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath),
  });
  await validateResumeBoundary(repoPath, planning.runId);
  await writeFile(join(planning.runPath, "contract.json"), "{}\n", "utf8");

  await assert.rejects(
    validateResumeBoundary(repoPath, planning.runId),
    /Artifact hash mismatch: contract\.json/,
  );
});

test("refuses resume when the persisted capability catalog is tampered", async (t) => {
  const repoPath = await fixtureRepo(t);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath),
  });
  const statePath = join(planning.runPath, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    repositoryCapabilities: { checks: Array<{ argv: string[] }> };
  };
  const first = state.repositoryCapabilities.checks[0];
  assert.ok(first);
  first.argv = ["npm", "run", "deploy"];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(
    validateResumeBoundary(repoPath, planning.runId),
    /capability catalog changed|capability catalog is missing or invalid/u,
  );
});

test("refuses resume when the tracked repository config changes", async (t) => {
  const config = {
    version: 1,
    checks: [{ id: "configured-test", kind: "test", argv: ["npm", "test"], cwd: "." }],
    testPathPrefixes: ["test"],
    testFilePatterns: ["*.test.ts"],
    controlFiles: [],
  };
  const repoPath = await createTestRepo(t, {
    prefix: "changesafely-config-resume-",
    files: {
      [REPOSITORY_CONFIG_PATH]: `${JSON.stringify(config, null, 2)}\n`,
      "src/value.ts": "export const value = 1;\n",
    },
  });
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath),
  });
  config.testFilePatterns.push("*.spec.ts");
  await writeFile(
    join(repoPath, REPOSITORY_CONFIG_PATH),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(
    validateResumeBoundary(repoPath, planning.runId),
    /capability catalog changed/u,
  );
});

test("persists malformed role output as a failed planning outcome", async (t) => {
  const repoPath = await fixtureRepo(t);

  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: fakeAppServerFactory(repoPath, "malformed"),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.phase, "failed");
  assert.equal(result.reasonCode, "ARTIFACT_VALIDATION_FAILED");
  assert.match(result.reason, /Invalid evidence artifact/);
});

test("marks a clean but changed baseline before the first write", async (t) => {
  const repoPath = await fixtureRepo(t);
  const clientFactory = fakeAppServerFactory(repoPath);
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory,
  });
  await writeFile(join(repoPath, "README.md"), "changed baseline\n", "utf8");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "change baseline"]);

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    /Baseline no longer matches/,
  );
  const state = await readRunState(planning.runPath);
  assert.equal(state.status, "BASELINE_CHANGED");
  assert.ok(
    (await loadTrace(repoPath, planning.runId)).events.some(
      (event) =>
        event.event === "state.transition" &&
        event.phase === "baseline-changed" &&
        event.status === "blocked",
    ),
  );
});

for (const scenario of [
  {
    name: "protected harness changes",
    mode: "protected-edit",
    message: /protected T1 path/,
    status: "FAILED",
  },
  {
    name: "scope expansion",
    mode: "scope-expansion",
    message: /expanded beyond selected plan/,
    status: "REPLAN_REQUIRED",
  },
  {
    name: "failed deterministic commands",
    mode: "failed-command",
    message: /Deterministic verification failed/,
    status: "FAILED",
  },
  {
    name: "protected configuration changes",
    mode: "protected-config",
    message: /Protected configuration metadata changed/,
    status: "FAILED",
  },
] as const) {
  test(`stops on ${scenario.name}`, async (t) => {
    const repoPath = await fixtureRepo(t);
    const clientFactory = fakeAppServerFactory(repoPath, scenario.mode);
    const planning = await runPlanning({
      repoPath,
      task: "Change the fixture value.",
      plannerCount: 1,
      clientFactory,
    });
    await runHarness({ repoPath, runId: planning.runId, clientFactory });

    await assert.rejects(
      runImplementationAndVerification({ repoPath, runId: planning.runId, clientFactory }),
      scenario.message,
    );
    const state = await readRunState(planning.runPath);
    assert.equal(state.status, scenario.status);
    if (scenario.mode === "failed-command") {
      const commands = JSON.parse(
        await readFile(join(planning.runPath, "verification-commands.json"), "utf8"),
      ) as { payload: Array<{ exitCode: number | null }> };
      assert.ok(commands.payload.some((command) => command.exitCode !== 0));
    }
  });
}
