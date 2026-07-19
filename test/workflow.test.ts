import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PreflightError } from "../src/git.js";
import { runHarness } from "../src/harness.js";
import { runImplementationAndVerification } from "../src/implementation.js";
import { validateResumeBoundary } from "../src/orchestrator.js";
import { loadTrace } from "../src/trace.js";
import { runPlanning } from "../src/workflow.js";
import { fakeAppServerFactory } from "./support/app-server.js";
import { createTestRepo, git, readRunState } from "./support/repository.js";

async function fixtureRepo(
  t: TestContext,
  testScript = "node --test",
  scripts: Record<string, string> = {},
): Promise<string> {
  return createTestRepo(t, {
    prefix: "changesafely-plan-",
    files: {
      "AGENTS.md": "# Fixture\n",
      "package.json": `${JSON.stringify({ name: "fixture", scripts: { test: testScript, ...scripts } }, null, 2)}\n`,
      "src/value.ts": "export const value = 1;\n",
    },
  });
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

test("creates a failing-first safety harness on a branch and commits T1", async (t) => {
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
  assert.deepEqual(Object.keys(harness.protectedHashes), ["test/value.test.ts"]);
  assert.equal(
    await git(repoPath, ["diff", "--name-only", baseline, harness.testCommit]),
    "test/value.test.ts",
  );
  const log = await git(repoPath, ["log", "--format=%s", "--reverse"]);
  assert.deepEqual(log.split("\n"), ["fixture baseline", "test: add ChangeSafely safety harness"]);
  const state = await readRunState(planning.runPath);
  assert.equal(state.testCommit, harness.testCommit);
  assert.equal(state.phase, "harness-complete");
  const contract = state.contexts.find((entry) => entry.role === "contract");
  const testAuthor = state.contexts.find((entry) => entry.role === "test-author");
  assert.equal(testAuthor?.parentThreadId, contract?.threadId);
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
    "test: add ChangeSafely safety harness",
    "feat: implement selected ChangeSafely plan",
  ]);
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
  const verifiers = state.contexts.filter((entry) => entry.role.startsWith("verifier"));
  assert.equal(repair?.threadId, implementer?.threadId);
  assert.equal(verifiers.length, 2);
  assert.notEqual(verifiers[0]?.threadId, verifiers[1]?.threadId);
  const log = await git(repoPath, ["log", "--format=%s", "--reverse"]);
  assert.deepEqual(log.split("\n"), [
    "fixture baseline",
    "test: add ChangeSafely safety harness",
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
