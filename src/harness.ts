import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
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
import {
  buildCoverageEvidence,
  type CoverageFailure,
  evaluateCoveragePlan,
  runCoverageChecks,
} from "./coverage.js";
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
import { evaluateHarnessEvidence, type HarnessEvidenceFailure } from "./harness-evidence.js";
import { type ProgressReporter, reportProgress } from "./progress.js";
import {
  changeHarnessPrompt,
  harnessCorrectionPrompt,
  harnessEvidenceCorrectionPrompt,
  harnessVerifierPrompt,
  testAuthorPrompt,
} from "./prompts.js";
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
  readOnlyPolicy,
  startContext,
  workspaceWritePolicy,
} from "./role-runtime.js";
import { type CommandResult, runCommand, toCommandEvidence } from "./runner.js";
import {
  type ChangeContract,
  type DecisionArtifact,
  type DetailedPlan,
  type HarnessArtifact,
  type HarnessReviewArtifact,
  harnessArtifactSchema,
  type StoredCharacterizationArtifact,
  type VerificationArtifact,
  validateHarnessArtifact,
  validateVerificationArtifact,
  verificationArtifactSchema,
} from "./schemas.js";
import { harnessReviewAccepted, hashRecordsEqual, verificationAccepted } from "./verification.js";

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

interface HarnessCorrection {
  commit: string;
  changedPaths: string[];
}

type HarnessGateOptions = { stage?: "characterization" | "change"; final?: boolean };
type HarnessGateFailure = CoverageFailure | HarnessEvidenceFailure;

function harnessError(code: string, message: string, exitCode: 1 | 2 = 1): ChangeSafelyError {
  return new ChangeSafelyError(code, message, {
    exitCode,
    nextAction: "Inspect the Test Author evidence and start a new run after fixing the cause.",
  });
}

function formatHarnessGateFailures(failures: HarnessGateFailure[]): string {
  return failures.map((failure) => `${failure.code}: ${failure.message}`).join("; ");
}

function assertHarnessEvidence(
  context: HarnessContext,
  harness: HarnessArtifact,
  options: HarnessGateOptions,
): void {
  const failures = evaluateHarnessEvidence(context.contract, context.plan, harness, options);
  if (failures.length > 0) {
    throw harnessError("HARNESS_EVIDENCE_INCOMPLETE", formatHarnessGateFailures(failures), 2);
  }
}

function assertCoveragePlan(context: HarnessContext, harness: HarnessArtifact): void {
  const failures = evaluateCoveragePlan(
    context.contract,
    context.plan,
    harness,
    context.capabilities,
  );
  if (failures.length > 0) {
    throw harnessError("COVERAGE_EVIDENCE_INCOMPLETE", formatHarnessGateFailures(failures), 2);
  }
}

function harnessGateFailures(
  context: HarnessContext,
  harness: HarnessArtifact,
  options: HarnessGateOptions,
): HarnessGateFailure[] {
  return [
    ...evaluateHarnessEvidence(context.contract, context.plan, harness, options),
    ...evaluateCoveragePlan(context.contract, context.plan, harness, context.capabilities),
  ];
}

function mergeNonInterference(
  characterization: HarnessArtifact,
  change: HarnessArtifact,
): HarnessArtifact["nonInterference"] {
  const applicable = [characterization, change].filter(
    (artifact) => artifact.nonInterference.status === "applicable",
  );
  return {
    status: applicable.length > 0 ? "applicable" : "not-applicable",
    targets: unique(applicable.flatMap((artifact) => artifact.nonInterference.targets)),
    checkIds: unique(applicable.flatMap((artifact) => artifact.nonInterference.checkIds)),
    evidenceBasis: [characterization, change].flatMap((artifact) =>
      artifact.nonInterference.evidenceBasis.slice(0, 1),
    ),
  };
}

function mergeCoverageAssessment(
  left: HarnessArtifact["coverage"]["matrix"]["branches"],
  right: HarnessArtifact["coverage"]["matrix"]["branches"],
): HarnessArtifact["coverage"]["matrix"]["branches"] {
  const covered = [left, right].filter((assessment) => assessment.status === "covered");
  return {
    status: covered.length > 0 ? "covered" : "not-applicable",
    detail: [left.detail, right.detail].join(" "),
    checkIds: unique(covered.flatMap((assessment) => assessment.checkIds)),
    relatedRiskIds: unique([...left.relatedRiskIds, ...right.relatedRiskIds]),
    evidenceBasis: [left, right].flatMap((assessment) => assessment.evidenceBasis.slice(0, 1)),
  };
}

function mergeCoverage(
  characterization: HarnessArtifact,
  change: HarnessArtifact,
): HarnessArtifact["coverage"] {
  return {
    status:
      characterization.coverage.status === "declared" && change.coverage.status === "declared"
        ? "declared"
        : "unknown",
    impactedPaths: unique([
      ...characterization.coverage.impactedPaths,
      ...change.coverage.impactedPaths,
    ]),
    matrix: {
      branches: mergeCoverageAssessment(
        characterization.coverage.matrix.branches,
        change.coverage.matrix.branches,
      ),
      stateTransitions: mergeCoverageAssessment(
        characterization.coverage.matrix.stateTransitions,
        change.coverage.matrix.stateTransitions,
      ),
      failures: mergeCoverageAssessment(
        characterization.coverage.matrix.failures,
        change.coverage.matrix.failures,
      ),
    },
    gaps: [...characterization.coverage.gaps, ...change.coverage.gaps],
  };
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
  state.harnessCorrectionCount ??= 0;
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
  allowedTestPaths = context.allowedTestPaths,
): Promise<ValidatedStage> {
  const { repoPath, state, capabilities } = context;
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

async function correctHarnessEvidenceOnce(input: {
  context: HarnessContext;
  client: AppServerClient;
  threadId: string;
  previousTurnId: string;
  stageName: "characterization" | "change";
  harness: HarnessArtifact;
  feedback: HarnessGateFailure[];
  gateOptions: HarnessGateOptions;
  immutablePaths?: string[];
  allowedTestPaths?: string[];
}): Promise<{ harness: HarnessArtifact; stage: ValidatedStage; turnId: string }> {
  const { context, client, threadId, previousTurnId, stageName, harness, feedback, gateOptions } =
    input;
  const { state, store, repoPath, options } = context;
  const immutablePaths = input.immutablePaths ?? [];
  const allowedTestPaths = input.allowedTestPaths ?? context.allowedTestPaths;
  state.phase = "harness-correction";
  state.nextAction = `Wait for bounded ${stageName} harness evidence correction.`;
  await store.writeState(state);
  await client.resumeThread({
    threadId,
    cwd: repoPath,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  const correctionRole = `test-author:evidence-correction:${stageName}`;
  const correctionContext = startContext(
    correctionRole,
    threadId,
    context.contractThreadId,
    previousTurnId,
  );
  state.contexts.push(correctionContext);
  await store.writeState(state);
  const correctionTurn = await client.runTurn(
    threadId,
    harnessEvidenceCorrectionPrompt({
      stage: stageName,
      contract: context.contract,
      plan: context.plan,
      decision: context.decision,
      harness,
      feedback,
      allowedTestPaths,
      immutablePaths,
    }),
    {
      cwd: repoPath,
      sandboxPolicy: workspaceWritePolicy(repoPath),
      effort: context.roleEffort,
      ...(options.model ? { model: options.model } : {}),
      outputSchema: harnessArtifactSchema,
      role: correctionRole,
      phase: "harness-correction",
    },
  );
  completeContext(correctionContext, correctionTurn.turnId);
  const correction = await parseRoleArtifact(correctionTurn.message, validateHarnessArtifact, {
    role: correctionRole,
    trace: store.trace,
  });
  if (correction.expectedBaselineOutcome !== harness.expectedBaselineOutcome) {
    throw harnessError(
      "HARNESS_CORRECTION_OUTCOME_CHANGED",
      "Harness evidence correction changed the established baseline outcome",
    );
  }
  const stage = await validateStageChanges(context, correction, immutablePaths, allowedTestPaths);
  const normalized = { ...correction, protectedPaths: stage.protectedPaths };
  const remaining = harnessGateFailures(context, normalized, gateOptions);
  if (remaining.length > 0) {
    throw harnessError("HARNESS_EVIDENCE_INCOMPLETE", formatHarnessGateFailures(remaining), 2);
  }
  return { harness: normalized, stage, turnId: correctionTurn.turnId };
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

async function persistBaselineCoverage(
  context: HarnessContext,
  harness: HarnessArtifact,
  characterizationCommit: string,
): Promise<void> {
  const { repoPath, options, capabilities, store, state } = context;
  const results = await runCoverageChecks({
    repoPath,
    capabilities,
    sandboxed: options.sandboxCommands ?? false,
    trace: store.trace,
    phase: "characterization-complete",
    ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const failed = results.filter(
    (result) => result.exitCode !== 0 || result.timedOut || result.signal !== null,
  );
  if (failed.length > 0) {
    throw harnessError(
      "BASELINE_COVERAGE_FAILED",
      `Baseline coverage failed: ${failed
        .map((result) => `${result.argv.join(" ")} exit ${result.exitCode}`)
        .join("; ")}`,
    );
  }
  await assertProtectedConfigurationUnchanged(repoPath, state.baselineProtectedConfiguration ?? {});
  const mutations = await changedPaths(repoPath, characterizationCommit);
  if (mutations.length > 0) {
    throw harnessError(
      "COVERAGE_COMMAND_MUTATED_REPOSITORY",
      `Coverage command changed tracked paths: ${mutations.join(", ")}`,
    );
  }
  const evidence = buildCoverageEvidence("baseline", harness, results, repoPath);
  const stored = await store.writeArtifact(
    "coverageBaseline",
    "deterministic-runner",
    evidence,
    artifactInputs(state, "characterization"),
  );
  state.artifacts.coverageBaseline = stored.hash;
}

async function persistAcceptedHarness(
  context: HarnessContext,
  harness: HarnessArtifact,
  testCommit: string,
  commandResults: CommandResult[],
  attempts: VerificationArtifact[],
  corrections: HarnessCorrection[],
): Promise<HarnessResult> {
  const { state, store, repoPath, selectedPlanKey, options, startedAt } = context;
  const protectedHashes = await hashFiles(repoPath, harness.protectedPaths);
  const review: HarnessReviewArtifact = {
    accepted: true,
    finalHarnessCommit: testCommit,
    attempts,
    corrections,
  };
  if (
    !harnessReviewAccepted(review, {
      checks: harness.checks,
      protectedPaths: harness.protectedPaths,
    })
  ) {
    throw harnessError(
      "HARNESS_REVIEW_INVALID",
      "Harness review evidence is internally inconsistent",
    );
  }
  const harnessStored = await store.writeArtifact(
    "harness",
    "test-author",
    { ...harness, protectedHashes, testCommit },
    artifactInputs(
      state,
      "characterization",
      "contract",
      "coverageBaseline",
      "decision",
      selectedPlanKey,
    ),
  );
  state.artifacts.harness = harnessStored.hash;
  const commandStored = await store.writeArtifact(
    "commands",
    "deterministic-runner",
    toCommandEvidence(commandResults, repoPath),
    artifactInputs(state, "harness"),
  );
  state.artifacts.commands = commandStored.hash;
  const reviewStored = await store.writeArtifact(
    "harnessReview",
    "verifier:harness",
    review,
    artifactInputs(
      state,
      "characterization",
      "characterizationCommands",
      "commands",
      "contract",
      "coverageBaseline",
      "decision",
      "harness",
      selectedPlanKey,
    ),
  );
  state.artifacts.harnessReview = reviewStored.hash;
  state.testCommit = testCommit;
  state.harnessCorrectionCount = corrections.length;
  state.phase = "harness-complete";
  state.status = "RUNNING";
  state.reason =
    state.characterizationCommit === testCommit
      ? "Independent review accepted the protected C1 refactor harness."
      : `Independent review accepted the protected C1/T1 harness after ${corrections.length} correction(s).`;
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
    command: commandResults.at(-1) as CommandResult,
    harness,
  };
}

function correctionTestScopes(context: HarnessContext): string[] {
  const configured = context.capabilities.testPathPrefixes.filter((path) =>
    pathWithinPrefixes(path, context.contract.allowedPathPrefixes),
  );
  return unique(
    configured.length > 0
      ? configured
      : context.allowedTestPaths.map((path) => posix.dirname(path)),
  );
}

function mergeHarness(current: HarnessArtifact, correction: HarnessArtifact): HarnessArtifact {
  return {
    ...correction,
    summary: `${current.summary} ${correction.summary}`,
    testPaths: unique([...current.testPaths, ...correction.testPaths]),
    fixturePaths: unique([...current.fixturePaths, ...correction.fixturePaths]),
    checks: [...current.checks, ...correction.checks],
    nonInterference: mergeNonInterference(current, correction),
    coverage: mergeCoverage(current, correction),
    protectedPaths: unique([...current.protectedPaths, ...correction.protectedPaths]),
  };
}

async function reviewHarness(
  context: HarnessContext,
  client: AppServerClient,
  testAuthorThreadId: string,
  testAuthorTurnId: string,
  initialHarness: HarnessArtifact,
  initialCommit: string,
  initialCommand: CommandResult,
): Promise<HarnessResult> {
  const { state, store, repoPath, options, startedAt } = context;
  const coverage = (await loadVerifiedArtifact(repoPath, state, "coverageBaseline")).payload;
  const characterizationCommands = (
    await loadVerifiedArtifact(repoPath, state, "characterizationCommands")
  ).payload;
  const characterizationCommit = state.characterizationCommit;
  if (!characterizationCommit) {
    throw harnessError("CHARACTERIZATION_COMMIT_MISSING", "C1 commit is missing before review", 2);
  }
  const attempts: VerificationArtifact[] = [];
  const corrections: HarnessCorrection[] = [];
  const commandResults = [initialCommand];
  const allowedTestScopes = correctionTestScopes(context);
  let harness = initialHarness;
  let testCommit = initialCommit;
  let lastTestAuthorTurnId = testAuthorTurnId;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state.phase = "harness-review";
    state.status = "RUNNING";
    state.nextAction = `Wait for independent harness review attempt ${attempt}.`;
    await store.writeState(state);
    reportProgress(
      options.onProgress,
      state.runId,
      state.phase,
      `Reviewing the protected harness (${attempt}/3)`,
      startedAt,
    );
    const fork = await client.forkThread({
      threadId: context.contractThreadId,
      lastTurnId: context.contractTurnId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const role = `verifier:harness:${attempt}`;
    const verifierContext = startContext(
      role,
      fork.thread.id,
      context.contractThreadId,
      context.contractTurnId,
    );
    state.contexts.push(verifierContext);
    await store.writeState(state);
    const turn = await client.runTurn(
      fork.thread.id,
      harnessVerifierPrompt({
        contract: context.contract,
        plan: context.plan,
        decision: context.decision,
        baselineCommit: state.baselineCommit,
        characterizationCommit,
        testCommit,
        characterizationDiff: await diffFrom(
          repoPath,
          state.baselineCommit,
          characterizationCommit,
        ),
        changeDiff:
          characterizationCommit === testCommit
            ? ""
            : await diffFrom(repoPath, characterizationCommit, testCommit),
        harness,
        protectedPaths: harness.protectedPaths,
        coverage,
        commandResults: {
          characterization: characterizationCommands,
          final: toCommandEvidence(commandResults, repoPath),
        },
      }),
      {
        cwd: repoPath,
        sandboxPolicy: readOnlyPolicy,
        effort: context.roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: verificationArtifactSchema,
        role,
        phase: "harness-review",
      },
    );
    completeContext(verifierContext, turn.turnId);
    const review = await parseRoleArtifact(turn.message, validateVerificationArtifact, {
      role,
      trace: store.trace,
    });
    attempts.push(review);
    if (verificationAccepted(review)) {
      return persistAcceptedHarness(
        context,
        harness,
        testCommit,
        commandResults,
        attempts,
        corrections,
      );
    }
    if (attempt === 3) {
      throw harnessError(
        "INSUFFICIENT_VERIFICATION_ENVIRONMENT",
        `Independent harness review remained insufficient after ${corrections.length} correction(s): ${review.reason}`,
        2,
      );
    }

    state.phase = "harness-correction";
    state.nextAction = `Wait for bounded Test Author correction ${attempt}.`;
    await store.writeState(state);
    await client.resumeThread({
      threadId: testAuthorThreadId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const correctionRole = `test-author:correction:${attempt}`;
    const correctionContext = startContext(
      correctionRole,
      testAuthorThreadId,
      context.contractThreadId,
      lastTestAuthorTurnId,
    );
    state.contexts.push(correctionContext);
    await store.writeState(state);
    const correctionTurn = await client.runTurn(
      testAuthorThreadId,
      harnessCorrectionPrompt({
        contract: context.contract,
        plan: context.plan,
        review,
        harness,
        immutablePaths: harness.protectedPaths,
        allowedTestScopes,
      }),
      {
        cwd: repoPath,
        sandboxPolicy: workspaceWritePolicy(repoPath),
        effort: context.roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: harnessArtifactSchema,
        role: correctionRole,
        phase: "harness-correction",
      },
    );
    completeContext(correctionContext, correctionTurn.turnId);
    lastTestAuthorTurnId = correctionTurn.turnId;
    const correction = await parseRoleArtifact(correctionTurn.message, validateHarnessArtifact, {
      role: correctionRole,
      trace: store.trace,
    });
    if (correction.expectedBaselineOutcome !== harness.expectedBaselineOutcome) {
      throw harnessError(
        "HARNESS_CORRECTION_OUTCOME_CHANGED",
        "Harness correction changed the established baseline outcome",
      );
    }
    const stage = await validateStageChanges(
      context,
      correction,
      harness.protectedPaths,
      allowedTestScopes,
    );
    const normalized = { ...correction, protectedPaths: stage.protectedPaths };
    assertHarnessEvidence(context, normalized, {
      stage: normalized.expectedBaselineOutcome === "pass" ? "characterization" : "change",
    });
    assertCoveragePlan(context, normalized);
    const merged = mergeHarness(harness, normalized);
    assertHarnessEvidence(context, merged, { final: true });
    assertCoveragePlan(context, merged);
    const command = await runStageCommand(context, normalized, harness.expectedBaselineOutcome);
    const commit = await commitPaths(
      repoPath,
      stage.changedPaths,
      `test: strengthen ChangeSafely harness (${attempt})`,
    );
    await store.trace.append({
      component: "git",
      event: "commit.created",
      status: "completed",
      phase: "harness-correction",
      role: correctionRole,
      commit,
    });
    corrections.push({ commit, changedPaths: stage.changedPaths });
    commandResults.push(command);
    harness = merged;
    testCommit = commit;
    state.testCommit = commit;
    state.harnessCorrectionCount = corrections.length;
    await store.writeState(state);
  }
  throw harnessError("HARNESS_REVIEW_INVALID", "Harness review loop ended unexpectedly");
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
    let lastTestAuthorTurnId = turn.turnId;
    const characterization = await parseRoleArtifact(turn.message, validateHarnessArtifact, {
      role: "test-author:characterization",
      trace: store.trace,
    });
    let stage = await validateStageChanges(context, characterization);
    let normalized = { ...characterization, protectedPaths: stage.protectedPaths };
    const gateOptions: HarnessGateOptions = {
      stage: "characterization",
      final: context.contract.changeKind === "refactor",
    };
    const gateFailures = harnessGateFailures(context, normalized, gateOptions);
    if (gateFailures.length > 0) {
      const corrected = await correctHarnessEvidenceOnce({
        context,
        client,
        threadId: fork.thread.id,
        previousTurnId: turn.turnId,
        stageName: "characterization",
        harness: normalized,
        feedback: gateFailures,
        gateOptions,
      });
      normalized = corrected.harness;
      stage = corrected.stage;
      lastTestAuthorTurnId = corrected.turnId;
    }
    assertHarnessEvidence(context, normalized, {
      stage: "characterization",
      final: context.contract.changeKind === "refactor",
    });
    assertCoveragePlan(context, normalized);
    const command = await runStageCommand(context, normalized, "pass");
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
    await persistBaselineCoverage(context, normalized, characterizationCommit);
    if (context.contract.changeKind === "refactor") {
      return await reviewHarness(
        context,
        client,
        fork.thread.id,
        lastTestAuthorTurnId,
        normalized,
        characterizationCommit,
        command,
      );
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
    state.status =
      failure instanceof ChangeSafelyError &&
      failure.code === "INSUFFICIENT_VERIFICATION_ENVIRONMENT"
        ? "BLOCKED"
        : "FAILED";
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
  const coverage = (await loadVerifiedArtifact(repoPath, state, "coverageBaseline")).payload;
  if (coverage.stage !== "baseline") {
    throw harnessError(
      "COVERAGE_BOUNDARY_MISMATCH",
      "C1 coverage artifact is not baseline evidence",
      2,
    );
  }
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
    await client.resumeThread({
      threadId: characterizationContext.threadId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
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
    let lastTestAuthorTurnId = turn.turnId;
    const change = await parseRoleArtifact(turn.message, validateHarnessArtifact, {
      role: "test-author:change",
      trace: store.trace,
    });
    const c1Paths = Object.keys(characterization.protectedHashes);
    let stage = await validateStageChanges(context, change, c1Paths);
    let normalizedChange = { ...change, protectedPaths: stage.protectedPaths };
    const gateOptions: HarnessGateOptions = { stage: "change" };
    const gateFailures = harnessGateFailures(context, normalizedChange, gateOptions);
    if (gateFailures.length > 0) {
      const corrected = await correctHarnessEvidenceOnce({
        context,
        client,
        threadId: characterizationContext.threadId,
        previousTurnId: turn.turnId,
        stageName: "change",
        harness: normalizedChange,
        feedback: gateFailures,
        gateOptions,
        immutablePaths: c1Paths,
      });
      normalizedChange = corrected.harness;
      stage = corrected.stage;
      lastTestAuthorTurnId = corrected.turnId;
    }
    assertHarnessEvidence(context, normalizedChange, { stage: "change" });
    assertCoveragePlan(context, normalizedChange);
    const finalHarness: HarnessArtifact = {
      ...normalizedChange,
      summary: `${characterization.summary} ${change.summary}`,
      testPaths: unique([...characterization.testPaths, ...change.testPaths]),
      fixturePaths: unique([...characterization.fixturePaths, ...change.fixturePaths]),
      checks: [...characterization.checks, ...change.checks],
      nonInterference: mergeNonInterference(characterization, change),
      coverage: mergeCoverage(characterization, change),
      protectedPaths: unique([...c1Paths, ...stage.protectedPaths]),
    };
    assertHarnessEvidence(context, finalHarness, { final: true });
    assertCoveragePlan(context, finalHarness);
    const command = await runStageCommand(context, normalizedChange, "fail");
    const testCommit = await commitPaths(
      repoPath,
      stage.changedPaths,
      "test: add ChangeSafely change harness",
    );
    await store.trace.append({
      component: "git",
      event: "commit.created",
      status: "completed",
      phase: "harness-review",
      role: "test-author:change",
      commit: testCommit,
    });
    return await reviewHarness(
      context,
      client,
      characterizationContext.threadId,
      lastTestAuthorTurnId,
      finalHarness,
      testCommit,
      command,
    );
  } catch (error) {
    const failure = abortReason(options.signal, error);
    if (options.signal?.aborted && (await canRestoreCharacterizationBoundary(context))) {
      state.phase = "characterization-complete";
      state.status = "RUNNING";
      state.reason = "C1 is intact after an interrupted change-harness attempt.";
      state.nextAction = "Resume from C1 to create the red change harness.";
    } else {
      state.status =
        failure instanceof ChangeSafelyError &&
        failure.code === "INSUFFICIENT_VERIFICATION_ENVIRONMENT"
          ? "BLOCKED"
          : "FAILED";
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
