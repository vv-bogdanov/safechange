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
import { abortReason, ChangeSafelyError } from "./errors.js";
import {
  assertNoUntrackedFiles,
  assertProtectedConfigurationUnchanged,
  canonicalRepositoryPath,
  changedPaths,
  commitPaths,
  currentBranch,
  currentCommit,
  diffFrom,
  hashFiles,
} from "./git.js";
import { type ProgressReporter, reportProgress } from "./progress.js";
import { implementerPrompt, repairPrompt, verifierPrompt } from "./prompts.js";
import { implementationReport } from "./report.js";
import {
  capabilitiesSha256,
  type RepositoryCapabilities,
  requireRepositoryCheck,
} from "./repository-capabilities.js";
import { isApprovalSensitivePath, pathWithinPrefixes } from "./repository-policy.js";
import {
  completeContext,
  parseRoleArtifact,
  readOnlyPolicy,
  startContext,
  workspaceWritePolicy,
} from "./role-runtime.js";
import { type CommandResult, runCommand, toCommandEvidence } from "./runner.js";
import {
  type DetailedPlan,
  type ImplementationArtifact,
  implementationArtifactSchema,
  type RunPhase,
  type StoredHarnessArtifact,
  type VerificationArtifact,
  validateImplementationArtifact,
  validateVerificationArtifact,
  verificationArtifactSchema,
} from "./schemas.js";
import type { TraceWriter } from "./trace.js";
import { hashRecordsEqual, verificationAccepted } from "./verification.js";

export interface ImplementationOptions {
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

export interface ImplementationResult {
  implementationCommit: string;
  commands: CommandResult[];
  verification: VerificationArtifact;
  accepted: boolean;
  reportPath: string;
}

function implementationError(
  code: string,
  message: string,
  exitCode: 1 | 2 = 1,
): ChangeSafelyError {
  return new ChangeSafelyError(code, message, {
    exitCode,
    nextAction: "Inspect implementation and verification evidence before starting a new run.",
  });
}

async function canRestoreHarnessBoundary(repoPath: string, state: RunState): Promise<boolean> {
  if (!state.testCommit || !state.branch || state.implementationCommit) return false;
  try {
    return (
      (await currentCommit(repoPath)) === state.testCommit &&
      (await currentBranch(repoPath)) === state.branch &&
      (await changedPaths(repoPath, state.testCommit)).length === 0
    );
  } catch {
    return false;
  }
}

interface ProjectCommand {
  argv: string[];
  cwd: string;
}

function projectCommands(harness: StoredHarnessArtifact, plan: DetailedPlan): ProjectCommand[] {
  const commands = [
    { argv: harness.targetedCommand.argv, cwd: harness.targetedCommand.cwd ?? "." },
    ...plan.verificationCommands.map(({ argv, cwd }) => ({ argv, cwd: cwd ?? "." })),
  ];
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = JSON.stringify(command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repairableVerification(verification: VerificationArtifact, planPaths: string[]): boolean {
  const errors = verification.findings.filter((finding) => finding.severity === "error");
  return (
    verification.verdict === "reject" &&
    verification.scopeConformant &&
    verification.evidenceSufficient &&
    errors.length > 0 &&
    errors.every((finding) => finding.path !== "" && pathWithinPrefixes(finding.path, planPaths))
  );
}

async function validateImplementationChange(input: {
  repoPath: string;
  fromCommit: string;
  artifact: ImplementationArtifact;
  harness: StoredHarnessArtifact;
  planPaths: string[];
  state: Awaited<ReturnType<typeof loadRunState>>;
}): Promise<string[]> {
  await assertProtectedConfigurationUnchanged(
    input.repoPath,
    input.state.baselineProtectedConfiguration ?? {},
  );
  const actualPaths = await changedPaths(input.repoPath, input.fromCommit);
  if (actualPaths.length === 0) {
    throw implementationError("IMPLEMENTATION_EMPTY", "Implementer made no production change");
  }
  const protectedAfter = await hashFiles(
    input.repoPath,
    Object.keys(input.harness.protectedHashes),
  );
  if (!hashRecordsEqual(input.harness.protectedHashes, protectedAfter)) {
    throw implementationError(
      "PROTECTED_HARNESS_CHANGED",
      "Implementer changed a protected T1 path",
    );
  }
  const outsidePlan = actualPaths.filter((path) => !pathWithinPrefixes(path, input.planPaths));
  if (outsidePlan.length > 0) {
    input.state.status = "REPLAN_REQUIRED";
    throw implementationError(
      "IMPLEMENTATION_SCOPE_EXPANDED",
      `Implementation expanded beyond selected plan: ${outsidePlan.join(", ")}`,
      2,
    );
  }
  const sensitive = actualPaths.filter((path) =>
    isApprovalSensitivePath(path, input.state.repositoryCapabilities?.controlFiles),
  );
  if (sensitive.length > 0) {
    input.state.status = "HUMAN_DECISION_REQUIRED";
    throw implementationError(
      "APPROVAL_REQUIRED",
      `Implementation changed approval-sensitive paths: ${sensitive.join(", ")}`,
      2,
    );
  }
  const declaredPaths = new Set(input.artifact.changedPaths);
  const omittedPaths = actualPaths.filter((path) => !declaredPaths.has(path));
  if (omittedPaths.length > 0) {
    throw implementationError(
      "IMPLEMENTATION_ARTIFACT_INCOMPLETE",
      `Implementation artifact omitted changed paths: ${omittedPaths.join(", ")}`,
    );
  }
  return actualPaths;
}

async function runProjectCommands(
  repoPath: string,
  harness: StoredHarnessArtifact,
  plan: DetailedPlan,
  sandboxed: boolean,
  protectedConfiguration: Record<string, string>,
  trace: TraceWriter,
  capabilities: RepositoryCapabilities,
  permissionProfile?: string,
  signal?: AbortSignal,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of projectCommands(harness, plan)) {
    requireRepositoryCheck(capabilities, command.argv, command.cwd);
    results.push(
      await runCommand(command.argv, resolve(repoPath, command.cwd), {
        sandboxed,
        ...(permissionProfile ? { permissionProfile } : {}),
        trace,
        phase: "deterministic-verification",
        ...(signal ? { signal } : {}),
      }),
    );
  }
  const protectedFinal = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
  if (!hashRecordsEqual(harness.protectedHashes, protectedFinal)) {
    throw implementationError(
      "PROTECTED_HARNESS_CHANGED",
      "Protected T1 paths changed during deterministic verification",
    );
  }
  await assertProtectedConfigurationUnchanged(repoPath, protectedConfiguration);
  return results;
}

function assertCommandsPassed(results: CommandResult[]): void {
  const failed = results.filter((result) => result.exitCode !== 0 || result.timedOut);
  if (failed.length > 0) {
    throw implementationError(
      "DETERMINISTIC_VERIFICATION_FAILED",
      `Deterministic verification failed: ${failed
        .map((result) => `${result.argv.join(" ")} exit ${result.exitCode}`)
        .join("; ")}`,
    );
  }
}

export async function runImplementationAndVerification(
  options: ImplementationOptions,
): Promise<ImplementationResult> {
  const startedAt = Date.now();
  const repoPath = await canonicalRepositoryPath(resolve(options.repoPath));
  const roleEffort = options.model ? "medium" : "low";
  const state = await loadRunState(repoPath, options.runId);
  state.repairCount ??= 0;
  const capabilities = state.repositoryCapabilities as RepositoryCapabilities | undefined;
  if (
    !capabilities ||
    !state.repositoryCapabilitiesSha256 ||
    capabilitiesSha256(capabilities) !== state.repositoryCapabilitiesSha256
  ) {
    throw implementationError(
      "CAPABILITY_CATALOG_INVALID",
      "Baseline capability catalog is missing or invalid",
      2,
    );
  }
  if (state.phase !== "harness-complete" || !state.testCommit || !state.branch) {
    throw implementationError(
      "IMPLEMENTATION_NOT_READY",
      `Run ${state.runId} is not ready for implementation`,
      2,
    );
  }
  if (
    (await currentCommit(repoPath)) !== state.testCommit ||
    (await currentBranch(repoPath)) !== state.branch
  ) {
    throw implementationError(
      "IMPLEMENTATION_BOUNDARY_MISMATCH",
      "Current Git branch or HEAD does not match the recorded T1 state",
      2,
    );
  }
  await assertNoUntrackedFiles(repoPath);

  const { contract, decision, plan } = await loadSelectedPlanArtifacts(repoPath, state);
  const selectedPlanKey = parsePlanArtifactKey(decision.winnerPlanId);
  const harness = (await loadVerifiedArtifact(repoPath, state, "harness")).payload;
  const harnessCommandEvidence = (await loadVerifiedArtifact(repoPath, state, "commands")).payload;
  if (harness.testCommit !== state.testCommit) {
    throw implementationError("HARNESS_COMMIT_MISMATCH", "Harness artifact does not match T1", 2);
  }
  const protectedBefore = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
  if (!hashRecordsEqual(harness.protectedHashes, protectedBefore)) {
    throw implementationError(
      "PROTECTED_HARNESS_CHANGED",
      "Protected harness differs from its recorded T1 hashes",
      2,
    );
  }
  const contractContext = state.contexts.find((entry) => entry.role === "contract");
  if (!contractContext?.turnId) {
    throw implementationError("CANONICAL_CONTEXT_MISSING", "Canonical C0 checkpoint is missing", 2);
  }

  const store = new ArtifactStore(repoPath, state.runId, state.baselineCommit, {
    ...(options.diagnostics ? { diagnostics: true } : {}),
  });
  state.phase = "implementer";
  state.nextAction = "Wait for the one selected implementation.";
  await store.writeState(state);
  reportProgress(
    options.onProgress,
    state.runId,
    state.phase,
    "Implementing the one selected plan",
    startedAt,
  );
  const client =
    options.clientFactory?.() ??
    new AppServerClient({
      cwd: repoPath,
      ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  client.setTrace(store.trace);
  let implementationCommit = "";
  let commandResults: CommandResult[] = [];
  let verification: VerificationArtifact | undefined;

  try {
    await client.start();
    const implementationFork = await client.forkThread({
      threadId: contractContext.threadId,
      lastTurnId: contractContext.turnId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const implementerContext = startContext(
      "implementer",
      implementationFork.thread.id,
      contractContext.threadId,
      contractContext.turnId,
    );
    state.contexts.push(implementerContext);
    await store.writeState(state);
    const implementationTurn = await client.runTurn(
      implementationFork.thread.id,
      implementerPrompt(
        contract,
        plan,
        decision,
        state.testCommit,
        Object.keys(harness.protectedHashes),
      ),
      {
        cwd: repoPath,
        sandboxPolicy: workspaceWritePolicy(repoPath),
        effort: roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: implementationArtifactSchema,
        role: "implementer",
        phase: "implementer",
      },
    );
    completeContext(implementerContext, implementationTurn.turnId);
    let implementation = await parseRoleArtifact(
      implementationTurn.message,
      validateImplementationArtifact,
      { role: "implementer", trace: store.trace },
    );
    const planPaths = [...new Set(plan.files.map((file) => file.path))];
    let actualPaths = await validateImplementationChange({
      repoPath,
      fromCommit: state.testCommit,
      artifact: implementation,
      harness,
      planPaths,
      state,
    });

    implementationCommit = await commitPaths(
      repoPath,
      actualPaths,
      "feat: implement selected ChangeSafely plan",
    );
    await store.trace.append({
      component: "git",
      event: "commit.created",
      status: "completed",
      phase: "implementer",
      role: "implementer",
      commit: implementationCommit,
    });
    state.implementationCommit = implementationCommit;
    const implementationStored = await store.writeArtifact(
      "implementation",
      "implementer",
      { ...implementation, implementationCommit, actualPaths },
      artifactInputs(state, "decision", "harness", selectedPlanKey),
    );
    state.artifacts.implementation = implementationStored.hash;
    state.phase = "deterministic-verification";
    await store.writeState(state);
    reportProgress(
      options.onProgress,
      state.runId,
      state.phase,
      "Running approved deterministic commands",
      startedAt,
    );

    commandResults = await runProjectCommands(
      repoPath,
      harness,
      plan,
      options.sandboxCommands ?? false,
      state.baselineProtectedConfiguration ?? {},
      store.trace,
      capabilities,
      options.permissionProfile,
      options.signal,
    );
    let commandsStored = await store.writeArtifact(
      "verificationCommands",
      "deterministic-runner",
      toCommandEvidence(commandResults, repoPath),
      artifactInputs(state, "implementation"),
    );
    state.artifacts.verificationCommands = commandsStored.hash;
    await store.writeState(state);
    assertCommandsPassed(commandResults);

    const verify = async (
      role: Extract<RunPhase, "verifier" | "verifier:repair">,
    ): Promise<VerificationArtifact> => {
      const actualDiff = await diffFrom(repoPath, state.baselineCommit);
      state.phase = role;
      await store.writeState(state);
      reportProgress(
        options.onProgress,
        state.runId,
        state.phase,
        role === "verifier" ? "Running independent verification" : "Verifying the bounded repair",
        startedAt,
      );
      const verifierFork = await client.forkThread({
        threadId: contractContext.threadId,
        lastTurnId: contractContext.turnId,
        cwd: repoPath,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const verifierContext = startContext(
        role,
        verifierFork.thread.id,
        contractContext.threadId,
        contractContext.turnId,
      );
      state.contexts.push(verifierContext);
      await store.writeState(state);
      const verifierTurn = await client.runTurn(
        verifierFork.thread.id,
        verifierPrompt({
          contract,
          plan,
          decision,
          baselineCommit: state.baselineCommit,
          testCommit: state.testCommit,
          implementationCommit,
          diff: actualDiff,
          commandResults: {
            harnessBaseline: harnessCommandEvidence,
            final: toCommandEvidence(commandResults, repoPath),
          },
        }),
        {
          cwd: repoPath,
          sandboxPolicy: readOnlyPolicy,
          effort: roleEffort,
          ...(options.model ? { model: options.model } : {}),
          outputSchema: verificationArtifactSchema,
          role,
          phase: role,
        },
      );
      completeContext(verifierContext, verifierTurn.turnId);
      return parseRoleArtifact(verifierTurn.message, validateVerificationArtifact, {
        role,
        trace: store.trace,
      });
    };

    verification = await verify("verifier");
    if (repairableVerification(verification, planPaths)) {
      const firstVerificationStored = await store.writeArtifact(
        "verificationAttempt1",
        "verifier",
        verification,
        artifactInputs(state, "implementation", "verificationCommands"),
      );
      state.artifacts.verificationAttempt1 = firstVerificationStored.hash;
      state.phase = "repair";
      state.repairCount = 1;
      state.nextAction = "Wait for the single bounded local repair.";
      await store.writeState(state);
      reportProgress(
        options.onProgress,
        state.runId,
        state.phase,
        "Applying one bounded local repair",
        startedAt,
      );

      await assertNoUntrackedFiles(repoPath);

      await client.resumeThread({
        threadId: implementationFork.thread.id,
        cwd: repoPath,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      const repairContext = startContext(
        "repair",
        implementationFork.thread.id,
        contractContext.threadId,
        implementerContext.turnId,
      );
      state.contexts.push(repairContext);
      await store.writeState(state);
      const repairTurn = await client.runTurn(
        implementationFork.thread.id,
        repairPrompt({
          contract,
          plan,
          verification,
          protectedPaths: Object.keys(harness.protectedHashes),
        }),
        {
          cwd: repoPath,
          sandboxPolicy: workspaceWritePolicy(repoPath),
          effort: roleEffort,
          ...(options.model ? { model: options.model } : {}),
          outputSchema: implementationArtifactSchema,
          role: "repair",
          phase: "repair",
        },
      );
      completeContext(repairContext, repairTurn.turnId);
      implementation = await parseRoleArtifact(repairTurn.message, validateImplementationArtifact, {
        role: "repair",
        trace: store.trace,
      });
      actualPaths = await validateImplementationChange({
        repoPath,
        fromCommit: implementationCommit,
        artifact: implementation,
        harness,
        planPaths,
        state,
      });
      implementationCommit = await commitPaths(
        repoPath,
        actualPaths,
        "fix: repair selected ChangeSafely implementation",
      );
      await store.trace.append({
        component: "git",
        event: "commit.created",
        status: "completed",
        phase: "repair",
        role: "repair",
        commit: implementationCommit,
      });
      state.implementationCommit = implementationCommit;
      const repairStored = await store.writeArtifact(
        "repair",
        "repair",
        { ...implementation, implementationCommit, actualPaths },
        artifactInputs(state, "verificationAttempt1"),
      );
      state.artifacts.repair = repairStored.hash;
      commandResults = await runProjectCommands(
        repoPath,
        harness,
        plan,
        options.sandboxCommands ?? false,
        state.baselineProtectedConfiguration ?? {},
        store.trace,
        capabilities,
        options.permissionProfile,
        options.signal,
      );
      commandsStored = await store.writeArtifact(
        "verificationCommandsRepair",
        "deterministic-runner",
        toCommandEvidence(commandResults, repoPath),
        artifactInputs(state, "repair"),
      );
      state.artifacts.verificationCommandsRepair = commandsStored.hash;
      await store.writeState(state);
      assertCommandsPassed(commandResults);
      verification = await verify("verifier:repair");
    }

    const verificationStored = await store.writeArtifact(
      "verification",
      state.repairCount === 1 ? "verifier:repair" : "verifier",
      verification,
      state.repairCount === 1
        ? artifactInputs(state, "repair", "verificationCommandsRepair")
        : artifactInputs(state, "implementation", "verificationCommands"),
    );
    state.artifacts.verification = verificationStored.hash;
    const accepted = verificationAccepted(verification);
    state.phase = "verification-complete";
    state.status = accepted ? "RUNNING" : "FAILED";
    state.reason = verification.reason;
    state.nextAction = accepted
      ? "Apply the final deterministic release gate."
      : state.repairCount === 1
        ? "The bounded repair was exhausted; inspect findings and start a new plan."
        : "Verifier findings are not safely repairable within the selected scope.";
    await store.writeState(state);
    reportProgress(
      options.onProgress,
      state.runId,
      state.phase,
      accepted
        ? "Independent verification accepted the change"
        : "Verification rejected the change",
      startedAt,
    );
    const reportPath = await store.writeText(
      "report.md",
      implementationReport(
        state,
        decision,
        toCommandEvidence(commandResults, repoPath),
        verification,
      ),
    );
    return { implementationCommit, commands: commandResults, verification, accepted, reportPath };
  } catch (error) {
    const failure = abortReason(options.signal, error);
    if (options.signal?.aborted && (await canRestoreHarnessBoundary(repoPath, state))) {
      state.status = "RUNNING";
      state.phase = "harness-complete";
      state.contexts = state.contexts.filter((entry) => entry.status === "completed");
      state.reason = failure instanceof Error ? failure.message : String(failure);
      state.nextAction = "Resume the run from the unchanged T1 harness boundary.";
      await store.writeState(state);
      await store.trace.recordFailure("workflow", "implementation.interrupted", failure, {
        phase: state.phase,
      });
      reportProgress(
        options.onProgress,
        state.runId,
        state.phase,
        "Interruption preserved the resumable T1 boundary",
        startedAt,
      );
      throw failure;
    }
    if (state.status === "RUNNING") {
      state.status =
        options.sandboxCommands && failure instanceof Error && /sandbox/i.test(failure.message)
          ? "BLOCKED"
          : "FAILED";
    }
    state.phase = "implementation-failed";
    state.reason = failure instanceof Error ? failure.message : String(failure);
    state.nextAction = "Inspect the branch and persisted artifacts; no cleanup was performed.";
    await store.writeState(state);
    await store.trace.recordFailure("workflow", "implementation.completed", failure, {
      phase: state.phase,
    });
    reportProgress(
      options.onProgress,
      state.runId,
      state.phase,
      "Implementation stopped",
      startedAt,
    );
    throw failure;
  } finally {
    await client.close();
  }
}
