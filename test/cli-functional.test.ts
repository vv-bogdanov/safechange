import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadVerifiedArtifact, type RunState } from "../src/artifacts.js";
import { runHarness } from "../src/harness.js";
import { runPlanning } from "../src/workflow.js";
import { fakeAppServerFactory } from "./support/app-server.js";
import {
  cliEnvironment,
  createFakeCodex,
  createFixtureRepository,
  createFunctionalRepository,
  installPackedCli,
  type ProcessResult,
  protocolVersion,
  runSuccessful,
  spawnCaptured,
} from "./support/packed-cli.js";

interface JsonOutcome {
  runId: string;
  status: string;
  phase: string;
  reasonCode: string;
  model: string | null;
  statePath: string;
  tracePath: string;
  manifestPath: string;
}

const root = process.cwd();
const fakeFixture = join(root, "dist", "test", "fixtures", "fake-app-server.js");

async function readState(path: string): Promise<RunState> {
  return JSON.parse(await readFile(path, "utf8")) as RunState;
}

async function readTrace(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

function parseOutcome(result: ProcessResult): JsonOutcome {
  return JSON.parse(result.stdout) as JsonOutcome;
}

test("packed CLI preserves its functional workflow contracts", { timeout: 180_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-cli-functional-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const { changesafely } = await installPackedCli(root, temporaryRoot);
  const codexVersion = await protocolVersion(root);

  const environment = async (mode = "default"): Promise<NodeJS.ProcessEnv> =>
    cliEnvironment(await createFakeCodex(temporaryRoot, codexVersion, fakeFixture, mode));

  const repository = async (name: string): Promise<string> => {
    const path = join(temporaryRoot, name);
    await createFunctionalRepository(path);
    return path;
  };

  const prepareHarness = async (name: string): Promise<{ repoPath: string; runId: string }> => {
    const repoPath = await repository(name);
    const clientFactory = fakeAppServerFactory(repoPath);
    const planning = await runPlanning({
      repoPath,
      task: "Change the fixture value.",
      plannerCount: 1,
      clientFactory,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = (await environment()).PATH;
    try {
      await runHarness({
        repoPath,
        runId: planning.runId,
        clientFactory,
        sandboxCommands: true,
      });
    } finally {
      process.env.PATH = previousPath;
    }
    return { repoPath, runId: planning.runId };
  };

  await t.test("fixture copies exclude stale Python runtime caches", async () => {
    const fixtureRoot = join(temporaryRoot, "cached-python-fixture");
    await mkdir(join(fixtureRoot, "src", "__pycache__"), { recursive: true });
    await mkdir(join(fixtureRoot, ".pytest_cache"), { recursive: true });
    await writeFile(join(fixtureRoot, "src", "value.py"), "def value():\n    return 1\n", "utf8");
    await writeFile(join(fixtureRoot, "src", "__pycache__", "value.pyc"), "stale", "utf8");
    await writeFile(join(fixtureRoot, ".pytest_cache", "state"), "stale", "utf8");

    const repoPath = join(temporaryRoot, "copied-python-fixture");
    await createFixtureRepository(repoPath, fixtureRoot);

    await assert.rejects(access(join(repoPath, "src", "__pycache__")), { code: "ENOENT" });
    await assert.rejects(access(join(repoPath, ".pytest_cache")), { code: "ENOENT" });
    await access(join(repoPath, "src", "value.py"));
  });

  await t.test("plan emits clean JSON and accepts an explicit Spark model", async () => {
    const repoPath = await repository("plan-json");
    const result = await spawnCaptured(
      changesafely,
      [
        "plan",
        "--task",
        "Change the fixture value.",
        "--plans",
        "1",
        "--model",
        "gpt-5.3-codex-spark",
        "--repo",
        repoPath,
        "--json",
      ],
      temporaryRoot,
      await environment("expect-workflow-spark"),
    ).result;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "PLANNED");
    assert.equal(outcome.model, "gpt-5.3-codex-spark");
    await access(outcome.tracePath);
    await access(outcome.manifestPath);
    assert.equal(await runSuccessful("git", ["status", "--porcelain=v1"], repoPath), "");
  });

  await t.test("full run applies and persists one configured permission profile", async () => {
    const repoPath = await repository("permission-profile");
    const result = await spawnCaptured(
      changesafely,
      [
        "run",
        "--task",
        "Change the fixture value.",
        "--plans",
        "1",
        "--permission-profile",
        "benchmark-profile",
        "--repo",
        repoPath,
        "--json",
      ],
      temporaryRoot,
      await environment("expect-permission-profile"),
    ).result;
    assert.equal(result.exitCode, 0);
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "VERIFIED");
    assert.equal(outcome.model, "gpt-5.6-sol");
    const state = await readState(outcome.statePath);
    const trace = await readTrace(outcome.tracePath);
    assert.equal(state.permissionProfile, "benchmark-profile");
    assert(trace.some((event) => event.sandboxPolicy === "permissions:benchmark-profile"));
  });

  await t.test("packed CLI completes a prepared pytest repository", async () => {
    const repoPath = join(temporaryRoot, "python-workflow");
    await createFixtureRepository(repoPath, join(root, "test", "fixtures", "python-project"));
    const result = await spawnCaptured(
      changesafely,
      [
        "run",
        "--task",
        "Return the requested value.",
        "--plans",
        "1",
        "--repo",
        repoPath,
        "--json",
      ],
      temporaryRoot,
      await environment("python"),
    ).result;
    const outcome = parseOutcome(result);
    const rerun =
      result.exitCode === 0
        ? undefined
        : await spawnCaptured("python", ["-m", "pytest"], repoPath).result;
    assert.equal(
      result.exitCode,
      0,
      `${result.stderr}\n${result.stdout}\nDirect pytest rerun:\n${rerun?.stdout ?? ""}\n${rerun?.stderr ?? ""}`,
    );
    assert.equal(outcome.status, "VERIFIED");
    const state = await readState(outcome.statePath);
    assert.deepEqual(
      state.repositoryCapabilities?.checks.map((check) => ({
        kind: check.kind,
        argv: check.argv,
        cwd: check.cwd,
      })),
      [{ kind: "test", argv: ["python", "-m", "pytest"], cwd: "." }],
    );
    assert.equal(
      await runSuccessful(
        "git",
        ["diff", "--name-only", state.baselineCommit, state.testCommit],
        repoPath,
      ),
      "tests/test_value.py\ntests/test_value_characterization.py",
    );
    const commands = await loadVerifiedArtifact(repoPath, state, "verificationCommands");
    assert.ok(commands.payload.every((command) => command.argv[0] === "python"));
  });

  await t.test("packed CLI runs a non-built-in check from explicit config", async () => {
    const repoPath = join(temporaryRoot, "configured-make-workflow");
    await createFixtureRepository(
      repoPath,
      join(root, "test", "fixtures", "configured-make-project"),
    );
    const result = await spawnCaptured(
      changesafely,
      [
        "run",
        "--task",
        "Return the requested value.",
        "--plans",
        "1",
        "--repo",
        repoPath,
        "--json",
      ],
      temporaryRoot,
      await environment("configured-make"),
    ).result;
    assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "VERIFIED");
    const state = await readState(outcome.statePath);
    assert.deepEqual(state.repositoryCapabilities?.checks, [
      { id: "make:test", kind: "test", argv: ["make", "test"], cwd: "." },
    ]);
    assert.ok(state.repositoryCapabilities?.sources.includes("config:changesafely.config.json"));
    assert.equal(
      await runSuccessful(
        "git",
        ["diff", "--name-only", state.baselineCommit, state.testCommit],
        repoPath,
      ),
      "checks/value_characterization_check.js\nchecks/value_check.js",
    );
    const commands = await loadVerifiedArtifact(repoPath, state, "verificationCommands");
    assert.deepEqual(
      commands.payload.map((command) => [command.argv, command.cwd, command.exitCode]),
      [[["make", "test"], ".", 0]],
    );
  });

  await t.test("packed CLI completes PHP through explicit config", async () => {
    const repoPath = join(temporaryRoot, "php-workflow");
    await createFixtureRepository(repoPath, join(root, "test", "fixtures", "php-project"));
    const result = await spawnCaptured(
      changesafely,
      [
        "run",
        "--task",
        "Return the requested value.",
        "--plans",
        "1",
        "--repo",
        repoPath,
        "--json",
      ],
      temporaryRoot,
      await environment("php"),
    ).result;
    assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "VERIFIED");
    const state = await readState(outcome.statePath);
    assert.deepEqual(state.repositoryCapabilities?.checks, [
      { id: "php:test", kind: "test", argv: ["php", "tests/run.php"], cwd: "." },
    ]);
    assert.deepEqual(state.repositoryCapabilities?.controlFiles, [
      "changesafely.config.json",
      "composer.json",
    ]);
    assert.equal(
      await runSuccessful(
        "git",
        ["diff", "--name-only", state.baselineCommit, state.testCommit],
        repoPath,
      ),
      "tests/value_characterization_test.php\ntests/value_test.php",
    );
    const commands = await loadVerifiedArtifact(repoPath, state, "verificationCommands");
    assert.deepEqual(
      commands.payload.map((command) => [command.argv, command.cwd, command.exitCode]),
      [[["php", "tests/run.php"], ".", 0]],
    );
  });

  await t.test("packed CLI keeps polyglot checks and test roots distinct", async () => {
    const repoPath = join(temporaryRoot, "polyglot-workflow");
    await createFixtureRepository(repoPath, join(root, "test", "fixtures", "polyglot-project"));
    const result = await spawnCaptured(
      changesafely,
      [
        "run",
        "--task",
        "Return the requested value from both producer and consumer.",
        "--plans",
        "1",
        "--repo",
        repoPath,
        "--json",
      ],
      temporaryRoot,
      await environment("polyglot"),
    ).result;
    assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "VERIFIED");
    const state = await readState(outcome.statePath);
    assert.deepEqual(
      state.repositoryCapabilities?.checks.map((check) => [check.argv, check.cwd]),
      [
        [["node", "--test"], "producer"],
        [["python", "-m", "pytest"], "consumer"],
      ],
    );
    assert.equal(
      await runSuccessful(
        "git",
        ["diff", "--name-only", state.baselineCommit, state.testCommit],
        repoPath,
      ),
      "consumer/tests/test_value.py\nconsumer/tests/test_value_characterization.py\nproducer/test/value.characterization.test.js\nproducer/test/value.test.js",
    );
    const harness = await loadVerifiedArtifact(repoPath, state, "harness");
    assert.deepEqual(Object.keys(harness.payload.protectedHashes).sort(), [
      "consumer/tests/test_value.py",
      "consumer/tests/test_value_characterization.py",
      "producer/test/value.characterization.test.js",
      "producer/test/value.test.js",
    ]);
    const commands = await loadVerifiedArtifact(repoPath, state, "verificationCommands");
    assert.deepEqual(
      commands.payload.map((command) => [command.argv, command.cwd, command.exitCode]),
      [
        [["node", "--test"], "producer", 0],
        [["python", "-m", "pytest"], "consumer", 0],
      ],
    );
  });

  await t.test("full run reports human progress on stderr", async () => {
    const repoPath = await repository("full-run");
    const result = await spawnCaptured(
      changesafely,
      ["run", "--task", "Change the fixture value.", "--plans", "1", "--repo", repoPath],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Status: VERIFIED/);
    assert.match(result.stderr, /\[changesafely\].*discovery/);
    assert.match(result.stderr, /\[changesafely\].*verified/);
    assert.equal(await runSuccessful("git", ["rev-list", "--count", "HEAD"], repoPath), "4");
    const runId = result.stdout.match(/^Run: (.+)$/m)?.[1];
    assert.ok(runId);
    const state = await readState(join(repoPath, ".changesafely", "runs", runId, "state.json"));
    assert.equal(await runSuccessful("git", ["branch", "--show-current"], repoPath), state.branch);
    assert.equal(
      await runSuccessful(
        "git",
        ["diff", "--name-only", state.baselineCommit, state.testCommit],
        repoPath,
      ),
      "test/value.characterization.test.ts\ntest/value.test.ts",
    );
    const harness = await loadVerifiedArtifact(repoPath, state, "harness");
    const verification = await loadVerifiedArtifact(repoPath, state, "verification");
    assert.ok(harness.payload.protectedHashes["test/value.test.ts"]);
    assert.ok(harness.payload.protectedHashes["test/value.characterization.test.ts"]);
    assert.equal(verification.payload.verdict, "accept");
    assert.match(
      await readFile(join(repoPath, ".changesafely", "runs", runId, "report.md"), "utf8"),
      /VERIFIED/,
    );
    const runPath = join(repoPath, ".changesafely", "runs", runId);
    const tracePath = join(runPath, "trace.jsonl");
    const traceContent = await readFile(tracePath, "utf8");
    const traceEvents = traceContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      traceEvents.map((event) => event.seq),
      Array.from({ length: traceEvents.length }, (_, index) => index + 1),
    );
    assert.ok(traceEvents.some((event) => event.event === "rpc.request"));
    assert.ok(traceEvents.some((event) => event.role === "implementer"));
    assert.ok(traceEvents.some((event) => event.artifactKey === "verification"));
    assert.ok(traceEvents.some((event) => event.commandId));
    assert.ok(
      traceEvents.some(
        (event) => event.event === "branch.created" && event.branch === state.branch,
      ),
    );
    assert.ok(traceEvents.some((event) => event.commit === state.testCommit));
    assert.ok(traceEvents.some((event) => event.commit === state.implementationCommit));
    assert.doesNotMatch(
      traceContent,
      /Change the fixture value|Small TypeScript fixture|requested value/,
    );
    await assert.rejects(access(join(runPath, "diagnostics")));

    const manifest = JSON.parse(await readFile(join(runPath, "manifest.json"), "utf8")) as {
      codexVersion: string;
      appServerUserAgent: string;
      completedAt: string | null;
      roles: Array<{ role: string; promptSha256: string; outputSchemaSha256?: string }>;
    };
    assert.equal(manifest.codexVersion, codexVersion);
    assert.equal(manifest.appServerUserAgent, "fake-app-server");
    assert.ok(manifest.completedAt);
    assert.ok(manifest.roles.some((role) => role.role === "verifier"));
    assert.ok(manifest.roles.every((role) => /^[a-f0-9]{64}$/.test(role.promptSha256)));
    const traceBefore = await readFile(tracePath, "utf8");
    const traced = await spawnCaptured(
      changesafely,
      ["trace", "--run", runId, "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(traced.exitCode, 0);
    const traceDocument = JSON.parse(traced.stdout) as {
      traceVersion: number;
      events: unknown[];
      analytics: { analyticsVersion: number; roleTurns: unknown[] };
    };
    assert.equal(traceDocument.traceVersion, 1);
    assert.equal(traceDocument.events.length, traceEvents.length);
    assert.equal(traceDocument.analytics.analyticsVersion, 1);
    assert.ok(traceDocument.analytics.roleTurns.length > 0);
    assert.equal(await readFile(tracePath, "utf8"), traceBefore);
  });

  await t.test("diagnostics opt-in persists bounded App Server stderr locally", async () => {
    const repoPath = await repository("diagnostics");
    const result = await spawnCaptured(
      changesafely,
      [
        "plan",
        "--task",
        "Change the fixture value.",
        "--plans",
        "1",
        "--repo",
        repoPath,
        "--diagnostics",
        "--json",
      ],
      temporaryRoot,
      await environment("stderr"),
    ).result;
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /diagnostics enabled/);
    const runId = parseOutcome(result).runId;
    const runPath = join(repoPath, ".changesafely", "runs", runId);
    const files = await readdir(join(runPath, "diagnostics"));
    assert.ok(files.some((file) => file.includes("app-server") && file.endsWith(".stderr.log")));
    const diagnostics = await Promise.all(
      files.map((file) => readFile(join(runPath, "diagnostics", file), "utf8")),
    );
    assert.match(diagnostics.join("\n"), /private-app-server-stderr-marker/);
    assert.doesNotMatch(
      await readFile(join(runPath, "trace.jsonl"), "utf8"),
      /private-app-server-stderr-marker/,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(join(runPath, "diagnostics"))).mode & 0o777, 0o700);
      for (const file of files) {
        assert.equal((await stat(join(runPath, "diagnostics", file))).mode & 0o777, 0o600);
      }
    }
  });

  await t.test("canonicalizes a repository path alias across phases", async () => {
    if (process.platform === "win32") return;
    const repoPath = await repository("canonical-repository");
    const alias = join(temporaryRoot, "repository-alias");
    await symlink(repoPath, alias, "dir");
    const result = await spawnCaptured(
      changesafely,
      ["run", "--task", "Change the fixture value.", "--plans", "1", "--repo", alias, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(result.exitCode, 0);
    const state = await readState(parseOutcome(result).statePath);
    assert.equal(state.repoPath, await realpath(repoPath));
  });

  await t.test("resume continues from planning and harness boundaries", async () => {
    const planningRepo = await repository("resume-planning");
    const plan = await spawnCaptured(
      changesafely,
      [
        "plan",
        "--task",
        "Change the fixture value.",
        "--plans",
        "1",
        "--repo",
        planningRepo,
        "--json",
      ],
      temporaryRoot,
      await environment(),
    ).result;
    const planned = parseOutcome(plan);
    const planningResume = await spawnCaptured(
      changesafely,
      ["resume", "--run", planned.runId, "--repo", planningRepo, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(planningResume.exitCode, 0);
    const planningOutcome = parseOutcome(planningResume);
    assert.equal(planningOutcome.status, "VERIFIED");
    assert.ok(
      (await readTrace(planningOutcome.tracePath)).some((event) => event.event === "run.resumed"),
    );

    const harness = await prepareHarness("resume-harness");
    const harnessResume = await spawnCaptured(
      changesafely,
      ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(harnessResume.exitCode, 0);
    const harnessOutcome = parseOutcome(harnessResume);
    assert.equal(harnessOutcome.status, "VERIFIED");
    assert.ok(
      (await readTrace(harnessOutcome.tracePath)).some((event) => event.event === "run.resumed"),
    );
  });

  await t.test("verifier rejection is explicit and persisted", async () => {
    const repoPath = await repository("verifier-reject");
    const result = await spawnCaptured(
      changesafely,
      ["run", "--task", "Change the fixture value.", "--plans", "1", "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment("verifier-reject"),
    ).result;
    assert.equal(result.exitCode, 1);
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reasonCode, "VERIFICATION_REJECTED");
    assert.equal((await readState(outcome.statePath)).status, "FAILED");
    assert.ok(
      (await readTrace(outcome.tracePath)).some(
        (event) => event.event === "phase.finished" && event.status === "failed",
      ),
    );
  });

  await t.test("status rejects corrupt and incompatible state without mutating it", async () => {
    const repoPath = await repository("incompatible-state");
    const plan = await spawnCaptured(
      changesafely,
      ["plan", "--task", "Change the fixture value.", "--plans", "1", "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    const outcome = parseOutcome(plan);
    const incompatible = `${JSON.stringify({ ...(await readState(outcome.statePath)), stateVersion: 2 }, null, 2)}\n`;
    await writeFile(outcome.statePath, incompatible, "utf8");
    const status = await spawnCaptured(
      changesafely,
      ["status", "--run", outcome.runId, "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(status.exitCode, 2);
    assert.equal(
      (JSON.parse(status.stdout) as { reasonCode: string }).reasonCode,
      "UNSUPPORTED_STATE_VERSION",
    );
    assert.equal(await readFile(outcome.statePath, "utf8"), incompatible);

    await writeFile(outcome.statePath, "{\n", "utf8");
    const corrupt = await spawnCaptured(
      changesafely,
      ["status", "--run", outcome.runId, "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(corrupt.exitCode, 2);
    assert.equal(
      (JSON.parse(corrupt.stdout) as { reasonCode: string }).reasonCode,
      "INVALID_PERSISTED_JSON",
    );
    assert.equal(await readFile(outcome.statePath, "utf8"), "{\n");
  });

  for (const [signal, expectedExit] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    await t.test(`${signal} preserves T1 and permits a safe resume`, async () => {
      if (process.platform === "win32") return;
      const harness = await prepareHarness(`interrupt-${signal.toLowerCase()}`);
      const processRun = spawnCaptured(
        changesafely,
        ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
        temporaryRoot,
        await environment("delay-implementer"),
      );
      await waitFor(join(harness.repoPath, ".changesafely", "test-implementer-started"));
      processRun.child.kill(signal);
      const interrupted = await processRun.result;
      assert.equal(interrupted.exitCode, expectedExit);
      const interruptedOutcome = parseOutcome(interrupted);
      assert.equal(interruptedOutcome.status, "RUNNING");
      assert.equal(interruptedOutcome.phase, "harness-complete");
      assert.equal(interruptedOutcome.reasonCode, "INTERRUPTED");
      const state = await readState(interruptedOutcome.statePath);
      assert.equal(
        await runSuccessful("git", ["rev-parse", "HEAD"], harness.repoPath),
        state.testCommit,
      );
      assert.equal(await runSuccessful("git", ["status", "--porcelain=v1"], harness.repoPath), "");
      await assert.rejects(access(join(harness.repoPath, ".git", "changesafely.lock")));
      assert.ok(
        (await readTrace(interruptedOutcome.tracePath)).some(
          (event) =>
            event.event === "implementation.interrupted" && event.reasonCode === "INTERRUPTED",
        ),
      );

      const resumed = await spawnCaptured(
        changesafely,
        ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
        temporaryRoot,
        await environment(),
      ).result;
      assert.equal(resumed.exitCode, 0);
      const resumedOutcome = parseOutcome(resumed);
      assert.equal(resumedOutcome.status, "VERIFIED");
      assert.ok(
        (await readTrace(resumedOutcome.tracePath)).filter((event) => event.event === "run.resumed")
          .length >= 2,
      );
    });
  }

  await t.test("total timeout preserves T1 and permits a safe resume", async () => {
    const harness = await prepareHarness("timeout");
    const timed = await spawnCaptured(
      changesafely,
      ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--timeout", "1", "--json"],
      temporaryRoot,
      await environment("delay-implementer"),
    ).result;
    assert.equal(timed.exitCode, 2);
    const outcome = parseOutcome(timed);
    assert.equal(outcome.status, "RUNNING");
    assert.equal(outcome.phase, "harness-complete");
    assert.equal(outcome.reasonCode, "WORKFLOW_TIMEOUT");
    assert.ok(
      (await readTrace(outcome.tracePath)).some(
        (event) =>
          event.event === "implementation.interrupted" && event.reasonCode === "WORKFLOW_TIMEOUT",
      ),
    );
    const resumed = await spawnCaptured(
      changesafely,
      ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(resumed.exitCode, 0);
    const resumedOutcome = parseOutcome(resumed);
    assert.equal(resumedOutcome.status, "VERIFIED");
    assert.ok(
      (await readTrace(resumedOutcome.tracePath)).filter((event) => event.event === "run.resumed")
        .length >= 2,
    );
  });
});
