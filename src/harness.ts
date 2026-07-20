import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppServerClient } from "./app-server/client.js";
import { parsePlanArtifactKey } from "./artifact-key.js";
import {
  ArtifactStore,
  artifactInputs,
  loadRunState,
  loadSelectedPlanArtifacts,
  loadVerifiedArtifact,
  type RunState,
} from "./artifacts.js";
import { evaluateContract, evaluatePlan } from "./eligibility.js";
import { abortReason, ChangeSafelyError } from "./errors.js";
import {
  assertProtectedConfigurationUnchanged,
  canonicalRepositoryPath,
  changedPaths,
  commitPaths,
  createChangeSafelyBranch,
  currentBranch,
  currentCommit,
  diffFrom,
  hashFiles,
  inspectBaseline,
} from "./git.js";
import { type ProgressReporter, reportProgress } from "./progress.js";
import { changeHarnessPrompt, testAuthorPrompt } from "./prompts.js";
import {
  authorizeRepositoryCheck,
  capabilitiesSha256,
  isCapabilityTestPath,
  type RepositoryCapabilities,
} from "./repository-capabilities.js";
import { pathWithinPrefixes } from "./repository-policy.js";
import {
  completeContext,
  parseRoleArtifact,
  startContext,
  workspaceWritePolicy,
} from "./role-runtime.js";
import { type CommandResult, runCommand, toCommandEvidence } from "./runner.js";
import {
  type ChangeContract,
  type DecisionArtifact,
  type DetailedPlan,
  type HarnessArtifact,
  harnessArtifactSchema,
  type StoredCharacterizationArtifact,
  validateHarnessArtifact,
} from "./schemas.js";
import { hashRecordsEqual } from "./verification.js";

export interface HarnessOptions {
  repoPath: string;
  runId: string;
  clientFactory?: () => AppServerClient;
  sandboxCommands?: boolean;
  model?: string;
  permissionProfile?: string;
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
  diagnostics?: boolean;
}

export interface HarnessResult {
  branch: string;
  characterizationCommit: string;
  testCommit: string;
  protectedHashes: Record<string, string>;
  command: CommandResult;
  harness: HarnessArtifact;
}

interface HarnessContext {
  options: HarnessOptions;
  startedAt: number;
  repoPath: string;
  roleEffort: "low" | "medium";
  state: RunState;
  capabilities: RepositoryCapabilities;
  contract: ChangeContract;
  decision: DecisionArtifact;
  plan: DetailedPlan;
  selectedPlanKey: ReturnType<typeof parsePlanArtifactKey>;
  allowedTestPaths: string[];
  contractThreadId: string;
  contractTurnId: string;
  store: ArtifactStore;
}

interface ValidatedStage {
  changedPaths: string[];
  protectedPaths: string[];
}

function harnessError(code: string, message: string, exitCode: 1 | 2 = 1): ChangeSafelyError {
  return new ChangeSafelyError(code, message, {
    exitCode,
    nextAction: "Inspect the Test Author evidence and start a new run after fixing the cause.",
  });
}

function selectedTestPaths(plan: DetailedPlan, capabilities: RepositoryCapabilities): string[] {
  const paths = new Set<string>();
  for (const file of plan.files) {
    if (isCapabilityTestPath(capabilities, file.path)) paths.add(file.path);
  }
  for (const step of plan.steps) {
    for (const path of step.paths) {
      if (isCapabilityTestPath(capabilities, path)) paths.add(path);
    }
  }
  if (paths.size === 0) {
    throw harnessError("HARNESS_PLAN_INVALID", "Selected plan does not declare a test path", 2);
  }
  return [...paths];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function diffRemovesExistingLines(diff: string): boolean {
  return diff.split("\n").some((line) => line.startsWith("-") && !line.startsWith("---"));
}

async function loadHarnessContext(
  options: HarnessOptions,
  startedAt: number,
): Promise<HarnessContext> {
  const repoPath = await canonicalRepositoryPath(resolve(options.repoPath));
  const state = await loadRunState(repoPath, options.runId);
  state.characterizationCommit ??= "";
  const capabilities = state.repositoryCapabilities as RepositoryCapabilities | undefined;
  if (
    !capabilities ||
    !state.repositoryCapabilitiesSha256 ||
    capabilitiesSha256(capabilities) !== state.repositoryCapabilitiesSha256
  ) {
    throw harnessError(
      "CAPABILITY_CATALOG_INVALID",
      "Baseline capability catalog is missing or invalid",
      2,
    );
  }
  if (
    state.status !== "PLANNED" &&
    !(state.phase === "characterization-complete" && state.status === "RUNNING")
  ) {
    throw harnessError(
      "HARNESS_NOT_READY",
      `Run ${state.runId} is not ready for harness creation: ${state.phase}/${state.status}`,
      2,
    );
  }

  const store = new ArtifactStore(repoPath, state.runId, state.baselineCommit, {
    ...(options.diagnostics ? { diagnostics: true } : {}),
  });
  const { contract, decision, plan } = await loadSelectedPlanArtifacts(repoPath, state);
  const contractFailures = evaluateContract(contract);
  const planGate = evaluatePlan(contract, plan, capabilities);
  if (contractFailures.length > 0 || !planGate.eligible) {
    const reasons = [
      ...contractFailures.map((failure) => `${failure.code}: ${failure.message}`),
      ...(contractFailures.length === 0
        ? planGate.failures.map((failure) => `${failure.code}: ${failure.message}`)
        : []),
      ...planGate.humanDecisionReasons,
    ];
    state.status = "BLOCKED";
    state.phase = "write-preflight-blocked";
    state.reason = reasons.join("; ");
    state.nextAction = "Resolve the contract or selected-plan gate and start a new planning run.";
    await store.writeState(state);
    reportProgress(options.onProgress, state.runId, state.phase, state.reason, startedAt);
    throw harnessError("WRITE_ELIGIBILITY_FAILED", state.reason, 2);
  }
  const contractContext = state.contexts.find((entry) => entry.role === "contract");
  if (!contractContext?.turnId) {
    throw harnessError("CANONICAL_CONTEXT_MISSING", "Canonical C0 checkpoint is missing", 2);
  }
  return {
    options,
    startedAt,
    repoPath,
    roleEffort: options.model ? "medium" : "low",
    state,
    capabilities,
    contract,
    decision,
    plan,
    selectedPlanKey: parsePlanArtifactKey(decision.winnerPlanId),
    allowedTestPaths: selectedTestPaths(plan, capabilities),
    contractThreadId: contractContext.threadId,
    contractTurnId: contractContext.turnId,
    store,
  };
}

function createClient(context: HarnessContext): AppServerClient {
  const { options, repoPath, store } = context;
  const client =
    options.clientFactory?.() ??
    new AppServerClient({
      cwd: repoPath,
      ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  client.setTrace(store.trace);
  return client;
}

async function validateStageChanges(
  context: HarnessContext,
  harness: HarnessArtifact,
  immutablePaths: string[] = [],
): Promise<ValidatedStage> {
  const { repoPath, state, capabilities, allowedTestPaths } = context;
  await assertProtectedConfigurationUnchanged(repoPath, state.baselineProtectedConfiguration ?? {});
  const paths = await changedPaths(repoPath, "HEAD");
  if (paths.length === 0) {
    throw harnessError("HARNESS_EMPTY", "Test Author did not create stage-specific evidence");
  }
  const protectedPaths = unique(harness.protectedPaths);
  const scopedPaths = unique([...paths, ...protectedPaths]);
  const unexpected = scopedPaths.filter(
    (path) =>
      !isCapabilityTestPath(capabilities, path) || !pathWithinPrefixes(path, allowedTestPaths),
  );
  if (unexpected.length > 0) {
    throw harnessError(
      "HARNESS_SCOPE_VIOLATION",
      `Test Author changed or protected paths outside test scope: ${unexpected.join(", ")}`,
    );
  }
  const changedProtected = paths.filter((path) => immutablePaths.includes(path));
  if (changedProtected.length > 0) {
    throw harnessError(
      "CHARACTERIZATION_CHANGED",
      `Change harness modified protected C1 paths: ${changedProtected.join(", ")}`,
    );
  }
  const undeclared = paths.filter((path) => !protectedPaths.includes(path));
  if (undeclared.length > 0) {
    throw harnessError(
      "HARNESS_PROTECTION_INCOMPLETE",
      `Harness omitted protected paths: ${undeclared.join(", ")}`,
    );
  }
  if (diffRemovesExistingLines(await diffFrom(repoPath, "HEAD"))) {
    throw harnessError(
      "HARNESS_WEAKENED_EXISTING_TESTS",
      "Harness removed or rewrote existing test/fixture lines",
    );
  }
  const changedContents = (
    await Promise.all(paths.map((path) => readFile(resolve(repoPath, path), "utf8")))
  ).join("\n");
  if (/\.(?:skip|only)\s*\(/.test(changedContents)) {
    throw harnessError("HARNESS_SKIP_ONLY", "Harness contains forbidden skip/only usage");
  }
  return { changedPaths: paths, protectedPaths };
}

async function runStageCommand(
  context: HarnessContext,
  harness: HarnessArtifact,
  expectedOutcome: "pass" | "fail",
): Promise<CommandResult> {
  const { plan, capabilities, options, repoPath, store, state } = context;
  if (harness.expectedBaselineOutcome !== expectedOutcome) {
    throw harnessError(
      "HARNESS_BASELINE_OUTCOME_INVALID",
      `Expected a baseline-${expectedOutcome} stage artifact`,
    );
  }
  const targetedCwd = harness.targetedCommand.cwd ?? ".";
  const plannedSafetyCommands = new Set(
    plan.safetyTests.map((test) => JSON.stringify([test.cwd ?? ".", test.argv])),
  );
  if (
    !plannedSafetyCommands.has(JSON.stringify([targetedCwd, harness.targetedCommand.argv])) ||
    !authorizeRepositoryCheck(capabilities, harness.targetedCommand.argv, targetedCwd, "test")
  ) {
    throw harnessError(
      "HARNESS_COMMAND_INVALID",
      "Harness targeted command must be a selected-plan test command",
    );
  }
  const command = await runCommand(harness.targetedCommand.argv, resolve(repoPath, targetedCwd), {
    sandboxed: options.sandboxCommands ?? false,
    ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
    trace: store.trace,
    phase: "test-author",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await assertProtectedConfigurationUnchanged(repoPath, state.baselineProtectedConfiguration ?? {});
  if (command.timedOut || command.signal || command.exitCode === null) {
    throw harnessError(
      "HARNESS_COMMAND_TECHNICAL_FAILURE",
      `Harness command did not complete normally: exit ${command.exitCode}, signal ${command.signal}, timedOut ${command.timedOut}`,
    );
  }
  if ((command.exitCode === 0) !== (expectedOutcome === "pass")) {
    const output = `${command.stdout}\n${command.stderr}`.slice(-1000);
    throw harnessError(
      "HARNESS_BASELINE_OUTCOME_MISMATCH",
      `Expected baseline ${expectedOutcome}, received exit ${command.exitCode}; output: ${output}`,
    );
  }
  if (expectedOutcome === "fail" && `${command.stdout}\n${command.stderr}`.trim() === "") {
    throw harnessError(
      "HARNESS_FAILURE_SIGNAL_MISSING",
      "Change harness exited non-zero without observable failure output",
    );
  }
  return command;
}

async function persistFinalHarness(
  context: HarnessContext,
  harness: HarnessArtifact,
  testCommit: string,
  command: CommandResult,
): Promise<HarnessResult> {
  const { state, store, repoPath, selectedPlanKey, options, startedAt } = context;
  const protectedHashes = await hashFiles(repoPath, harness.protectedPaths);
  const harnessStored = await store.writeArtifact(
    "harness",
    "test-author",
    { ...harness, protectedHashes, testCommit },
    artifactInputs(state, "characterization", "contract", "decision", selectedPlanKey),
  );
  state.artifacts.harness = harnessStored.hash;
  const commandStored = await store.writeArtifact(
    "commands",
    "deterministic-runner",
    toCommandEvidence([command], repoPath),
    artifactInputs(state, "harness"),
  );
  state.artifacts.commands = commandStored.hash;
  state.testCommit = testCommit;
  state.phase = "harness-complete";
  state.status = "RUNNING";
  state.reason =
    state.characterizationCommit === testCommit
      ? "Protected C1 refactor harness committed before implementation."
      : "Protected C1 and T1 harnesses committed before implementation.";
  state.nextAction = "Run the Implementer from C0 using the selected plan and protected harness.";
  await store.writeState(state);
  if ((await currentCommit(repoPath)) !== testCommit) {
    throw harnessError(
      "HARNESS_COMMIT_MISMATCH",
      "Git HEAD does not match the final harness commit",
    );
  }
  reportProgress(
    options.onProgress,
    state.runId,
    state.phase,
    state.characterizationCommit === testCommit
      ? "Characterization harness committed as C1"
      : "Change harness committed as T1",
    startedAt,
  );
  return {
    branch: state.branch,
    characterizationCommit: state.characterizationCommit ?? "",
    testCommit,
    protectedHashes,
    command,
    harness,
  };
}

async function createCharacterization(context: HarnessContext): Promise<HarnessResult | undefined> {
  const { state, store, repoPath, options, capabilities, startedAt } = context;
  const baseline = await inspectBaseline(repoPath, capabilities.controlFiles);
  if (
    baseline.commit !== state.baselineCommit ||
    baseline.fingerprint !== state.baselineFingerprint
  ) {
    state.status = "BASELINE_CHANGED";
    state.phase = "baseline-changed";
    state.reason = "Baseline no longer matches planning artifacts.";
    state.nextAction = "Start a new planning run from the current baseline.";
    await store.writeState(state);
    throw harnessError("BASELINE_CHANGED", state.reason, 2);
  }
  try {
    state.branch = await createChangeSafelyBranch(baseline, state.runId);
  } catch (error) {
    state.status = "BLOCKED";
    state.phase = "write-preflight-blocked";
    state.reason = error instanceof Error ? error.message : String(error);
    state.nextAction = "Move or commit pre-existing files, then start a new ChangeSafely run.";
    await store.writeState(state);
    throw error;
  }
  await store.trace.append({
    component: "git",
    event: "branch.created",
    status: "completed",
    phase: "test-author",
    branch: state.branch,
  });
  state.phase = "test-author";
  state.status = "RUNNING";
  state.nextAction = "Wait for the baseline-green characterization harness.";
  await store.writeState(state);
  reportProgress(
    options.onProgress,
    state.runId,
    state.phase,
    "Creating the characterization harness",
    startedAt,
  );

  const client = createClient(context);
  try {
    await client.start();
    const fork = await client.forkThread({
      threadId: context.contractThreadId,
      lastTurnId: context.contractTurnId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const roleContext = startContext(
      "test-author:characterization",
      fork.thread.id,
      context.contractThreadId,
      context.contractTurnId,
    );
    state.contexts.push(roleContext);
    await store.writeState(state);
    const turn = await client.runTurn(
      fork.thread.id,
      testAuthorPrompt(
        context.contract,
        context.plan,
        context.decision,
        context.allowedTestPaths,
        capabilities,
      ),
      {
        cwd: repoPath,
        sandboxPolicy: workspaceWritePolicy(repoPath),
        effort: context.roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: harnessArtifactSchema,
        role: "test-author:characterization",
        phase: "test-author",
      },
    );
    completeContext(roleContext, turn.turnId);
    const characterization = await parseRoleArtifact(turn.message, validateHarnessArtifact, {
      role: "test-author:characterization",
      trace: store.trace,
    });
    const stage = await validateStageChanges(context, characterization);
    const command = await runStageCommand(context, characterization, "pass");
    const characterizationCommit = await commitPaths(
      repoPath,
      stage.changedPaths,
      "test: add ChangeSafely characterization harness",
    );
    await store.trace.append({
      component: "git",
      event: "commit.created",
      status: "completed",
      phase: "characterization-complete",
      role: "test-author:characterization",
      commit: characterizationCommit,
    });
    const normalized = { ...characterization, protectedPaths: stage.protectedPaths };
    const protectedHashes = await hashFiles(repoPath, stage.protectedPaths);
    const stored = await store.writeArtifact(
      "characterization",
      "test-author:characterization",
      { ...normalized, protectedHashes, characterizationCommit },
      artifactInputs(state, "contract", "decision", context.selectedPlanKey),
    );
    state.artifacts.characterization = stored.hash;
    const commands = await store.writeArtifact(
      "characterizationCommands",
      "deterministic-runner",
      toCommandEvidence([command], repoPath),
      artifactInputs(state, "characterization"),
    );
    state.artifacts.characterizationCommands = commands.hash;
    state.characterizationCommit = characterizationCommit;
    if (context.contract.changeKind === "refactor") {
      return await persistFinalHarness(context, normalized, characterizationCommit, command);
    }
    state.phase = "characterization-complete";
    state.status = "RUNNING";
    state.reason = "Baseline-green characterization harness committed as C1.";
    state.nextAction = "Continue the same Test Author from C1 to create the red change harness.";
    await store.writeState(state);
    reportProgress(
      options.onProgress,
      state.runId,
      state.phase,
      "Characterization harness committed as C1",
      startedAt,
    );
    return undefined;
  } catch (error) {
    const failure = abortReason(options.signal, error);
    state.status = "FAILED";
    state.phase = "test-author-failed";
    state.reason = failure instanceof Error ? failure.message : String(failure);
    state.nextAction =
      "Inspect the ChangeSafely branch and Test Author diff; no cleanup was performed.";
    await store.writeState(state);
    await store.trace.recordFailure("workflow", "characterization.completed", failure, {
      phase: state.phase,
      role: "test-author:characterization",
    });
    throw failure;
  } finally {
    await client.close();
  }
}

async function loadCharacterization(
  context: HarnessContext,
): Promise<StoredCharacterizationArtifact> {
  const { state, repoPath } = context;
  const artifact = (await loadVerifiedArtifact(repoPath, state, "characterization")).payload;
  await assertProtectedConfigurationUnchanged(repoPath, state.baselineProtectedConfiguration ?? {});
  if (
    !state.characterizationCommit ||
    artifact.characterizationCommit !== state.characterizationCommit ||
    (await currentCommit(repoPath)) !== state.characterizationCommit ||
    (await currentBranch(repoPath)) !== state.branch ||
    (await changedPaths(repoPath, state.characterizationCommit)).length > 0
  ) {
    throw harnessError(
      "CHARACTERIZATION_BOUNDARY_MISMATCH",
      "Current Git state does not match C1",
      2,
    );
  }
  const actual = await hashFiles(repoPath, Object.keys(artifact.protectedHashes));
  if (!hashRecordsEqual(artifact.protectedHashes, actual)) {
    throw harnessError("CHARACTERIZATION_CHANGED", "Protected C1 hashes changed before T1", 2);
  }
  return artifact;
}

async function canRestoreCharacterizationBoundary(context: HarnessContext): Promise<boolean> {
  const commit = context.state.characterizationCommit;
  if (!commit || !context.state.branch || context.state.testCommit) return false;
  try {
    return (
      (await currentCommit(context.repoPath)) === commit &&
      (await currentBranch(context.repoPath)) === context.state.branch &&
      (await changedPaths(context.repoPath, commit)).length === 0
    );
  } catch {
    return false;
  }
}

async function createChangeHarness(context: HarnessContext): Promise<HarnessResult> {
  const { state, store, repoPath, options, startedAt } = context;
  const characterization = await loadCharacterization(context);
  const characterizationContext = state.contexts.find(
    (entry) => entry.role === "test-author:characterization",
  );
  if (!characterizationContext?.turnId) {
    throw harnessError("CHARACTERIZATION_CONTEXT_MISSING", "Test Author C1 context is missing", 2);
  }
  state.phase = "test-author";
  state.nextAction = "Wait for the baseline-red change harness.";
  await store.writeState(state);
  reportProgress(
    options.onProgress,
    state.runId,
    state.phase,
    "Creating the change harness",
    startedAt,
  );

  const client = createClient(context);
  try {
    await client.start();
    const roleContext = startContext(
      "test-author:change",
      characterizationContext.threadId,
      context.contractThreadId,
      characterizationContext.turnId,
    );
    state.contexts.push(roleContext);
    await store.writeState(state);
    const turn = await client.runTurn(
      characterizationContext.threadId,
      changeHarnessPrompt(
        context.contract,
        context.plan,
        context.decision,
        state.characterizationCommit ?? "",
        characterization,
        context.allowedTestPaths,
        context.capabilities,
      ),
      {
        cwd: repoPath,
        sandboxPolicy: workspaceWritePolicy(repoPath),
        effort: context.roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: harnessArtifactSchema,
        role: "test-author:change",
        phase: "test-author",
      },
    );
    completeContext(roleContext, turn.turnId);
    const change = await parseRoleArtifact(turn.message, validateHarnessArtifact, {
      role: "test-author:change",
      trace: store.trace,
    });
    const c1Paths = Object.keys(characterization.protectedHashes);
    const stage = await validateStageChanges(context, change, c1Paths);
    const command = await runStageCommand(context, change, "fail");
    const testCommit = await commitPaths(
      repoPath,
      stage.changedPaths,
      "test: add ChangeSafely change harness",
    );
    await store.trace.append({
      component: "git",
      event: "commit.created",
      status: "completed",
      phase: "harness-complete",
      role: "test-author:change",
      commit: testCommit,
    });
    const finalHarness: HarnessArtifact = {
      ...change,
      summary: `${characterization.summary} ${change.summary}`,
      testPaths: unique([...characterization.testPaths, ...change.testPaths]),
      fixturePaths: unique([...characterization.fixturePaths, ...change.fixturePaths]),
      protectedPaths: unique([...c1Paths, ...stage.protectedPaths]),
    };
    return await persistFinalHarness(context, finalHarness, testCommit, command);
  } catch (error) {
    const failure = abortReason(options.signal, error);
    if (options.signal?.aborted && (await canRestoreCharacterizationBoundary(context))) {
      state.phase = "characterization-complete";
      state.status = "RUNNING";
      state.reason = "C1 is intact after an interrupted change-harness attempt.";
      state.nextAction = "Resume from C1 to create the red change harness.";
    } else {
      state.status = "FAILED";
      state.phase = "test-author-failed";
      state.reason = failure instanceof Error ? failure.message : String(failure);
      state.nextAction =
        "Inspect the ChangeSafely branch and Test Author diff; no cleanup was performed.";
    }
    await store.writeState(state);
    await store.trace.recordFailure("workflow", "change-harness.completed", failure, {
      phase: state.phase,
      role: "test-author:change",
    });
    throw failure;
  } finally {
    await client.close();
  }
}

export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const startedAt = Date.now();
  const context = await loadHarnessContext(options, startedAt);
  if (context.state.status === "PLANNED") {
    const refactorHarness = await createCharacterization(context);
    if (refactorHarness) return refactorHarness;
  }
  return createChangeHarness(context);
}
