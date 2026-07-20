import { resolve } from "node:path";
import { AppServerClient } from "./app-server/client.js";
import { type ArtifactKey, type PlanArtifactKey, planArtifactKey } from "./artifact-key.js";
import { ArtifactStore, artifactInputs, createRunId, type RunState } from "./artifacts.js";
import {
  evaluateContract,
  evaluatePlan,
  evaluatePlans,
  type PlanEligibility,
} from "./eligibility.js";
import { abortReason, ChangeSafelyError } from "./errors.js";
import { assertBaselineUnchanged, canonicalRepositoryPath, inspectBaseline } from "./git.js";
import { createRunOutcome, type RunOutcome } from "./outcome.js";
import { type ProgressReporter, reportProgress } from "./progress.js";
import {
  contractPrompt,
  discoveryPrompt,
  judgeCorrectionPrompt,
  judgePrompt,
  plannerCorrectionPrompt,
  plannerPrompt,
} from "./prompts.js";
import { planningReport } from "./report.js";
import {
  assertUsableCapabilities,
  capabilitiesSha256,
  discoverRepositoryCapabilities,
} from "./repository-capabilities.js";
import {
  completeContext,
  parseRoleArtifact,
  readOnlyPolicy,
  startContext,
} from "./role-runtime.js";
import {
  changeContractSchema,
  type DecisionArtifact,
  type DetailedPlan,
  decisionArtifactSchema,
  detailedPlanSchema,
  evidenceArtifactSchema,
  RUN_STATE_VERSION,
  type RunPhase,
  validateChangeContract,
  validateDecisionArtifact,
  validateDetailedPlan,
  validateEvidenceArtifact,
} from "./schemas.js";
import { VERSION } from "./version.js";

const plannerLenses = [
  "minimal-change",
  "reversible-change",
  "risk-first",
  "testability-first",
  "operations-first",
] as const;

export interface PlanningOptions {
  repoPath: string;
  task: string;
  plannerCount: number;
  clientFactory?: () => AppServerClient;
  parallelPlanners?: boolean;
  model?: string;
  permissionProfile?: string;
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
  diagnostics?: boolean;
}

export interface PlanningResult extends RunOutcome {
  decision?: DecisionArtifact;
}

function planningError(code: string, message: string): ChangeSafelyError {
  return new ChangeSafelyError(code, message, {
    nextAction: "Inspect planning artifacts and start a new run after fixing the cause.",
  });
}

export async function runPlanning(options: PlanningOptions): Promise<PlanningResult> {
  const startedAt = Date.now();
  const repoPath = await canonicalRepositoryPath(resolve(options.repoPath));
  const roleEffort = options.model ? "medium" : "low";
  const repositoryCapabilities = await discoverRepositoryCapabilities(repoPath);
  assertUsableCapabilities(repositoryCapabilities);
  const repositoryCapabilitiesSha256 = capabilitiesSha256(repositoryCapabilities);
  const baseline = await inspectBaseline(repoPath, repositoryCapabilities.controlFiles);
  const runId = createRunId();
  const store = new ArtifactStore(baseline.repoPath, runId, baseline.commit, {
    ...(options.diagnostics ? { diagnostics: true } : {}),
  });
  await store.initialize();
  await store.trace.initializeManifest(options.model ?? "");
  await store.trace.append({
    component: "git",
    event: "baseline.captured",
    status: "completed",
    phase: "preflight",
    commit: baseline.commit,
  });
  await store.trace.append({
    component: "repository",
    event: "capabilities.discovered",
    status: "completed",
    phase: "preflight",
    artifactHash: repositoryCapabilitiesSha256,
  });

  const state: RunState = {
    stateVersion: RUN_STATE_VERSION,
    producerVersion: VERSION,
    runId,
    task: options.task,
    repoPath: baseline.repoPath,
    baselineCommit: baseline.commit,
    baselineFingerprint: baseline.fingerprint,
    baselineProtectedConfiguration: baseline.protectedConfiguration,
    repositoryCapabilities,
    repositoryCapabilitiesSha256,
    phase: "preflight",
    status: "RUNNING",
    reason: "",
    nextAction: "Wait for planning to complete.",
    artifacts: {},
    contexts: [],
    branch: "",
    characterizationCommit: "",
    testCommit: "",
    implementationCommit: "",
    repairCount: 0,
    model: options.model ?? "",
    permissionProfile: options.permissionProfile ?? "",
  };
  await store.writeState(state);
  reportProgress(options.onProgress, runId, "preflight", "Baseline captured", startedAt);

  const client =
    options.clientFactory?.() ??
    new AppServerClient({
      cwd: baseline.repoPath,
      ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  client.setTrace(store.trace);
  const plans: DetailedPlan[] = [];
  let eligibility: PlanEligibility[] = [];
  let decision: DecisionArtifact | undefined;

  const persist = async (phase: RunPhase): Promise<void> => {
    state.phase = phase;
    await store.writeState(state);
    const actions: Partial<Record<RunPhase, string>> = {
      discovery: "Collecting repository evidence",
      contract: "Building the canonical change contract",
      planners: "Comparing independent plans",
      eligibility: "Applying deterministic eligibility gates",
      judge: "Selecting one eligible plan",
    };
    reportProgress(options.onProgress, runId, phase, actions[phase] ?? phase, startedAt);
  };
  const addArtifact = (name: ArtifactKey, artifactHash: string): void => {
    state.artifacts[name] = artifactHash;
  };

  try {
    await client.start();

    await persist("discovery");
    const discoveryThread = await client.startThread({
      cwd: baseline.repoPath,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const discoveryContext = startContext("discovery", discoveryThread.thread.id, null, null);
    state.contexts.push(discoveryContext);
    await store.writeState(state);
    const discoveryTurn = await client.runTurn(
      discoveryThread.thread.id,
      discoveryPrompt(options.task, repositoryCapabilities),
      {
        cwd: baseline.repoPath,
        sandboxPolicy: readOnlyPolicy,
        effort: roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: evidenceArtifactSchema,
        role: "discovery",
        phase: "discovery",
      },
    );
    completeContext(discoveryContext, discoveryTurn.turnId);
    const evidence = await parseRoleArtifact(discoveryTurn.message, validateEvidenceArtifact, {
      role: "discovery",
      trace: store.trace,
    });
    const evidenceStored = await store.writeArtifact("evidence", "discovery", evidence);
    addArtifact("evidence", evidenceStored.hash);
    await store.writeState(state);

    await persist("contract");
    const contractThread = await client.startThread({
      cwd: baseline.repoPath,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const contractContext = startContext("contract", contractThread.thread.id, null, null);
    state.contexts.push(contractContext);
    await store.writeState(state);
    const contractTurn = await client.runTurn(
      contractThread.thread.id,
      contractPrompt(options.task, evidence),
      {
        cwd: baseline.repoPath,
        sandboxPolicy: readOnlyPolicy,
        effort: roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: changeContractSchema,
        role: "contract",
        phase: "contract",
      },
    );
    completeContext(contractContext, contractTurn.turnId);
    const contractArtifact = await parseRoleArtifact(contractTurn.message, validateChangeContract, {
      role: "contract",
      trace: store.trace,
    });
    const contractStored = await store.writeArtifact(
      "contract",
      "contract",
      contractArtifact,
      artifactInputs(state, "evidence"),
    );
    addArtifact("contract", contractStored.hash);
    await store.writeState(state);

    const contractFailures = evaluateContract(contractArtifact);
    if (contractFailures.length > 0) {
      state.status = "BLOCKED";
      state.reason = contractFailures
        .map((failure) => `${failure.code}: ${failure.message}`)
        .join("; ");
      state.nextAction =
        "Resolve the contract evidence or critical uncertainty and start a new run.";
      await assertBaselineUnchanged(baseline);
      state.phase = "planning-complete";
      await store.writeState(state);
      reportProgress(
        options.onProgress,
        runId,
        state.phase,
        "Contract blocked planning",
        startedAt,
      );
      const reportPath = await store.writeText(
        "report.md",
        planningReport(state, plans, eligibility, decision),
      );
      await store.trace.append({
        component: "workflow",
        event: "run.completed",
        status: "blocked",
        phase: state.phase,
      });
      return await createRunOutcome(repoPath, state, reportPath);
    }

    await persist("planners");
    const plannerRuns: Array<() => Promise<{ planId: PlanArtifactKey; plan: DetailedPlan }>> = [];
    for (let index = 0; index < options.plannerCount; index += 1) {
      const planId = planArtifactKey(index + 1);
      const lens = plannerLenses[index];
      if (!lens) throw planningError("PLANNER_LENS_MISSING", `No planner lens for index ${index}`);
      const fork = await client.forkThread({
        threadId: contractThread.thread.id,
        lastTurnId: contractTurn.turnId,
        cwd: baseline.repoPath,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const plannerContext = startContext(
        `planner:${planId}`,
        fork.thread.id,
        contractThread.thread.id,
        contractTurn.turnId,
      );
      state.contexts.push(plannerContext);
      plannerRuns.push(async () => {
        const plannerTurn = await client.runTurn(
          fork.thread.id,
          plannerPrompt(planId, lens, contractArtifact, repositoryCapabilities),
          {
            cwd: baseline.repoPath,
            sandboxPolicy: readOnlyPolicy,
            effort: roleEffort,
            ...(options.model ? { model: options.model } : {}),
            outputSchema: detailedPlanSchema,
            role: `planner:${planId}`,
            phase: "planners",
          },
        );
        completeContext(plannerContext, plannerTurn.turnId);
        let plan = await parseRoleArtifact(plannerTurn.message, validateDetailedPlan, {
          role: `planner:${planId}`,
          trace: store.trace,
        });
        if (plan.planId !== planId || plan.lens !== lens) {
          throw planningError(
            "PLANNER_IDENTITY_MISMATCH",
            `Planner identity mismatch: expected ${planId}/${lens}, got ${plan.planId}/${plan.lens}`,
          );
        }
        const firstGate = evaluatePlan(contractArtifact, plan, repositoryCapabilities);
        if (!firstGate.eligible) {
          const correctionContext = startContext(
            `planner-correction:${planId}`,
            fork.thread.id,
            contractThread.thread.id,
            plannerTurn.turnId,
          );
          state.contexts.push(correctionContext);
          const correctionTurn = await client.runTurn(
            fork.thread.id,
            plannerCorrectionPrompt(
              planId,
              lens,
              contractArtifact,
              plan,
              firstGate,
              repositoryCapabilities,
            ),
            {
              cwd: baseline.repoPath,
              sandboxPolicy: readOnlyPolicy,
              effort: roleEffort,
              ...(options.model ? { model: options.model } : {}),
              outputSchema: detailedPlanSchema,
              role: `planner-correction:${planId}`,
              phase: "planners",
            },
          );
          completeContext(correctionContext, correctionTurn.turnId);
          plan = await parseRoleArtifact(correctionTurn.message, validateDetailedPlan, {
            role: `planner-correction:${planId}`,
            trace: store.trace,
          });
          if (plan.planId !== planId || plan.lens !== lens) {
            throw planningError(
              "PLANNER_IDENTITY_MISMATCH",
              `Corrected planner identity mismatch: expected ${planId}/${lens}, got ${plan.planId}/${plan.lens}`,
            );
          }
        }
        return { planId, plan };
      });
    }
    await store.writeState(state);
    const plannerResults = options.parallelPlanners
      ? await Promise.all(plannerRuns.map((run) => run()))
      : await plannerRuns.reduce<Promise<Array<{ planId: PlanArtifactKey; plan: DetailedPlan }>>>(
          async (previous, run) => [...(await previous), await run()],
          Promise.resolve([]),
        );
    for (const { planId, plan } of plannerResults) {
      plans.push(plan);
      const stored = await store.writeArtifact(
        planId,
        `planner:${planId}`,
        plan,
        artifactInputs(state, "contract"),
      );
      addArtifact(planId, stored.hash);
    }
    await store.writeState(state);

    await persist("eligibility");
    eligibility = evaluatePlans(contractArtifact, plans, repositoryCapabilities);
    const eligibilityStored = await store.writeArtifact(
      "eligibility",
      "deterministic-eligibility",
      eligibility,
      artifactInputs(state, "contract", ...plannerResults.map(({ planId }) => planId)),
    );
    addArtifact("eligibility", eligibilityStored.hash);
    const eligiblePlanIds = new Set(
      eligibility.filter((item) => item.eligible).map((item) => item.planId),
    );
    const eligiblePlans = plans.filter((plan) => eligiblePlanIds.has(plan.planId));

    if (eligiblePlans.length === 0) {
      const humanReasons = eligibility.flatMap((item) => item.humanDecisionReasons);
      state.status = humanReasons.length > 0 ? "HUMAN_DECISION_REQUIRED" : "BLOCKED";
      state.reason =
        humanReasons.length > 0
          ? humanReasons.join("; ")
          : "No plan passed deterministic eligibility gates.";
      state.nextAction =
        humanReasons.length > 0
          ? "Approve or reject the declared sensitive changes, then start a new plan run."
          : "Resolve the reported evidence, scope, or verification gaps and start a new run.";
    } else {
      await persist("judge");
      const judgeFork = await client.forkThread({
        threadId: contractThread.thread.id,
        lastTurnId: contractTurn.turnId,
        cwd: baseline.repoPath,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const judgeContext = startContext(
        "judge",
        judgeFork.thread.id,
        contractThread.thread.id,
        contractTurn.turnId,
      );
      state.contexts.push(judgeContext);
      await store.writeState(state);
      const judgeTurn = await client.runTurn(
        judgeFork.thread.id,
        judgePrompt(contractArtifact, eligiblePlans, eligibility),
        {
          cwd: baseline.repoPath,
          sandboxPolicy: readOnlyPolicy,
          effort: roleEffort,
          ...(options.model ? { model: options.model } : {}),
          outputSchema: decisionArtifactSchema,
          role: "judge",
          phase: "judge",
        },
      );
      completeContext(judgeContext, judgeTurn.turnId);
      decision = await parseRoleArtifact(judgeTurn.message, validateDecisionArtifact, {
        role: "judge",
        trace: store.trace,
      });
      if (decision.humanDecisionRequired) {
        const correctionContext = startContext(
          "judge-correction",
          judgeFork.thread.id,
          contractThread.thread.id,
          judgeTurn.turnId,
        );
        state.contexts.push(correctionContext);
        const correctionTurn = await client.runTurn(
          judgeFork.thread.id,
          judgeCorrectionPrompt(contractArtifact, eligiblePlans, eligibility, decision),
          {
            cwd: baseline.repoPath,
            sandboxPolicy: readOnlyPolicy,
            effort: roleEffort,
            ...(options.model ? { model: options.model } : {}),
            outputSchema: decisionArtifactSchema,
            role: "judge-correction",
            phase: "judge",
          },
        );
        completeContext(correctionContext, correctionTurn.turnId);
        decision = await parseRoleArtifact(correctionTurn.message, validateDecisionArtifact, {
          role: "judge-correction",
          trace: store.trace,
        });
      }
      if (!eligiblePlanIds.has(decision.winnerPlanId)) {
        throw planningError(
          "JUDGE_SELECTED_INELIGIBLE_PLAN",
          `Judge selected ineligible or unknown plan ${decision.winnerPlanId}`,
        );
      }
      const decisionStored = await store.writeArtifact(
        "decision",
        "judge",
        decision,
        artifactInputs(state, "contract", "eligibility"),
      );
      addArtifact("decision", decisionStored.hash);
      if (decision.humanDecisionRequired) {
        state.status = "HUMAN_DECISION_REQUIRED";
        state.reason = decision.humanDecisionReason;
        state.nextAction = "Resolve the Judge's explicit human decision before implementation.";
      } else {
        state.status = "PLANNED";
        state.reason = `Selected ${decision.winnerPlanId}: ${decision.reason}`;
        state.nextAction =
          "Run ChangeSafely with the approved selected plan to create the safety harness.";
      }
    }

    await assertBaselineUnchanged(baseline);
    state.phase = "planning-complete";
    await store.writeState(state);
    reportProgress(options.onProgress, runId, state.phase, "Planning outcome persisted", startedAt);
    const reportPath = await store.writeText(
      "report.md",
      planningReport(state, plans, eligibility, decision),
    );
    await store.trace.append({
      component: "workflow",
      event: "run.completed",
      status: state.status === "PLANNED" ? "completed" : "blocked",
      phase: state.phase,
    });
    return {
      ...(await createRunOutcome(repoPath, state, reportPath)),
      ...(decision ? { decision } : {}),
    };
  } catch (error) {
    const failure = abortReason(options.signal, error);
    state.status = "FAILED";
    state.phase = "failed";
    state.reason = failure instanceof Error ? failure.message : String(failure);
    state.nextAction =
      "Inspect state.json and the last role artifact, then fix the cause and retry.";
    await store.writeState(state);
    reportProgress(options.onProgress, runId, state.phase, "Planning stopped", startedAt);
    const reportPath = await store.writeText(
      "report.md",
      planningReport(state, plans, eligibility, decision),
    );
    await store.trace.recordFailure("workflow", "run.completed", failure, {
      phase: state.phase,
    });
    if (!(failure instanceof ChangeSafelyError)) throw failure;
    return {
      ...(await createRunOutcome(repoPath, state, reportPath, failure.code)),
      ...(decision ? { decision } : {}),
    };
  } finally {
    await client.close();
  }
}
