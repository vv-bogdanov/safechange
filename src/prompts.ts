import type { PlanEligibility } from "./eligibility.js";
import type { RepositoryCapabilities } from "./repository-capabilities.js";
import type {
  ChangeContract,
  DecisionArtifact,
  DetailedPlan,
  EvidenceArtifact,
} from "./schemas.js";

export const HIGH_ASSURANCE_DOCTRINE = `Search broadly for ways the change can fail.
Assert behavior only when grounded in the task or repository evidence.
Treat preservation of unrelated observable behavior as equal to acceptance.
Map every critical risk to executable evidence.
Stop when a critical uncertainty cannot be resolved safely.
Do not infer success from model confidence or a green suite alone.`;

const RISK_DIRECTIONS =
  "Consider applicable behavior, state, effects, failures, time, and boundary risks; justify concrete non-applicability instead of generating boilerplate.";

function data(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function roleHeader(role: string): string {
  return `[CHANGESAFELY_ROLE:${role}]
${HIGH_ASSURANCE_DOCTRINE}`;
}

export function discoveryPrompt(task: string, capabilities: RepositoryCapabilities): string {
  return `${roleHeader("discovery")}

Objective: build verified repository evidence for the task without proposing a solution.

Directions: inspect the complete relevant impact surface, including callers, shared state, side effects, failures, temporal behavior, identities, and operational configuration. ${RISK_DIRECTIONS} Treat the capability catalog as the complete command authority; do not invent commands. Record facts with repository-relative references, existing checks, test gaps, instruction constraints, assumptions, and unknowns.

Boundary: work read-only and network-off. Do not edit files, inspect secret contents, or expose credentials. An unresolved fact remains an unknown.

Output: return only the schema-constrained Evidence Artifact.

User task:
${task}

Repository capability catalog:
${data(capabilities)}`;
}

export function contractPrompt(task: string, evidence: EvidenceArtifact): string {
  return `${roleHeader("contract")}

Objective: define the observable safe change and the behavior that must remain intact from a clean C0 root.

Directions: use only the user task and validated evidence. Give every acceptance criterion and protected invariant a stable unique id. Separate the required delta, preservation, non-goals, risks, evidence gaps, approval-sensitive changes, and unresolved semantics. Ground every non-obvious assertion in the task or evidence. allowedPathPrefixes constrain later writes, never read-only inspection.

Boundary: work read-only and network-off. Do not convert a plausible safety failure into a non-goal or invent semantics to resolve uncertainty. Surface critical ambiguity explicitly.

Output: return only the schema-constrained Change Contract.

User task:
${task}

Validated evidence:
${data(evidence)}`;
}

export function plannerPrompt(
  planId: string,
  lens: string,
  contract: ChangeContract,
  capabilities: RepositoryCapabilities,
): string {
  return `${roleHeader("planner")}

Objective: as independent planner ${planId}, whose lens is: ${lens}, produce one self-contained admissible plan with the strongest practical evidence and smallest sufficient production delta.

Directions: cover every contract id, declare all planned paths and sensitive changes, and make risks, assumptions, unknowns, recovery, and rejection reasons explicit. ${RISK_DIRECTIONS} Select every safety and verification command verbatim by argv and cwd from the capability catalog; safety tests must select kind test. Record only actual new dependencies, migrations, and approval-sensitive changes. Materially apply the assigned lens without expanding scope for variety.

Boundary: work read-only. Do not edit files or invent command authority. If the lens cannot produce a safe admissible plan, say why in rejectionReasons rather than disguising the gap.

Output: set planId to ${planId}, lens to ${lens}, and return only the schema-constrained Detailed Plan.

Repository capability catalog:
${data(capabilities)}

Canonical contract:
${data(contract)}`;
}

export function plannerCorrectionPrompt(
  planId: string,
  lens: string,
  contract: ChangeContract,
  plan: DetailedPlan,
  gate: PlanEligibility,
  capabilities: RepositoryCapabilities,
): string {
  return `${roleHeader("planner")}
[CHANGESAFELY_CORRECTION]

Objective: as the same planner ${planId}, whose lens is: ${lens}, correct the rejected artifact once.

Directions: address only the deterministic gate feedback while preserving genuine risks and sensitive changes. Questions belong in unknowns. Approval-required changes contain only changes this plan actually performs. Commands must remain verbatim catalog argv/cwd values and safety tests must select kind test.

Boundary: work read-only. Do not broaden scope, hide uncertainty, or edit files. If the plan remains unsafe, preserve the blocking reason.

Output: set planId to ${planId}, lens to ${lens}, and return only the complete corrected Detailed Plan.

Gate feedback:
${data(gate)}

Repository capability catalog:
${data(capabilities)}

Contract:
${data(contract)}

Rejected artifact:
${data(plan)}`;
}

export function judgePrompt(
  contract: ChangeContract,
  plans: DetailedPlan[],
  eligibility: PlanEligibility[],
): string {
  return `${roleHeader("judge")}

Objective: choose the eligible plan with the strongest executable evidence and lowest unresolved safety risk.

Directions: compare only validated eligible plans and deterministic gate results. Evaluate contract coverage, protected invariants, failure evidence, scope, recovery, and residual uncertainty. Use simplicity as a tie-breaker after safety sufficiency. Explain the winner, concrete rejections, tradeoffs, and residual risks without numerical scores.

Boundary: work read-only. Do not select an ineligible plan or downgrade a critical unresolved choice into an ordinary residual risk.

Output: winnerPlanId must name one supplied eligible plan; return only the schema-constrained Decision Artifact.

Contract:
${data(contract)}

Plans:
${data(plans)}

Eligibility:
${data(eligibility)}`;
}

export function judgeCorrectionPrompt(
  contract: ChangeContract,
  plans: DetailedPlan[],
  eligibility: PlanEligibility[],
  decision: DecisionArtifact,
): string {
  return `${roleHeader("judge")}
[CHANGESAFELY_CORRECTION]

Objective: correct the same Judge decision once after deterministic decision validation.

Directions: every supplied plan already passed scope and approval gates. Keep humanDecisionRequired only when an unresolved choice changes the selected implementation now; retain non-blocking concerns as residual risks. Preserve critical safety concerns and select only a supplied eligible plan.

Boundary: work read-only. Do not invent approval requirements or hide a blocking decision.

Output: return only the complete corrected Decision Artifact.

Contract:
${data(contract)}

Eligible plans:
${data(plans)}

Eligibility:
${data(eligibility)}

Rejected decision:
${data(decision)}`;
}

export function testAuthorPrompt(
  contract: ChangeContract,
  plan: DetailedPlan,
  decision: DecisionArtifact,
  allowedTestPaths: string[],
  capabilities: RepositoryCapabilities,
): string {
  return `${roleHeader("test-author")}

Objective: build the strongest available pre-implementation safety harness required by the selected plan.

Directions: prefer functional checks through stable boundaries. ${RISK_DIRECTIONS} Cover the required delta and protected behavior with observable assertions grounded in the task or repository. For preservation or refactoring evidence, the declared baseline outcome may pass; for a missing behavior, it must fail for that intended reason. Append coverage or create focused test/fixture files without rewriting existing tests. targetedCommand must copy one selected-plan kind-test command verbatim from the catalog. protectedPaths must include every changed path.

Boundary: you are the only writer and network is off. Change only the allowed test/fixture scope below. Do not change production code, manifests, lockfiles, instructions, public behavior, existing test lines, or secret/config files. Do not use skip, only, weak assertions, or mocks of the behavior being proved. Stop rather than invent an unsupported oracle.

Output: return only the schema-constrained Harness Artifact after editing.

Allowed test and fixture paths/prefixes:
${data(allowedTestPaths)}

Repository capability catalog:
${data(capabilities)}

Contract:
${data(contract)}

Selected plan:
${data(plan)}

Judge decision:
${data(decision)}`;
}

export function implementerPrompt(
  contract: ChangeContract,
  plan: DetailedPlan,
  decision: DecisionArtifact,
  testCommit: string,
  protectedPaths: string[],
): string {
  return `${roleHeader("implementer")}

Objective: implement the selected plan with the smallest sufficient production delta.

Directions: satisfy the contract and protected harness without opportunistic cleanup, redesign, speculative abstractions, or behavior outside the selected plan. Report every changed path, added test, scope note, and residual risk.

Boundary: you are the only writer and network is off. You forked from C0, not a Planner or Test Author transcript. The protected harness commit is ${testCommit}; do not edit, delete, rename, stage differently, or weaken these paths:
${data(protectedPaths)}
Do not introduce unplanned dependencies, migrations, API changes, permissions, secrets, deployment actions, or paths. If the contract, harness, or scope cannot support a safe implementation, make no speculative change and report the blocking issue.

Output: return only the schema-constrained Implementation Artifact after editing.

Contract:
${data(contract)}

Selected plan:
${data(plan)}

Judge decision:
${data(decision)}`;
}

export function verifierPrompt(input: {
  contract: ChangeContract;
  plan: DetailedPlan;
  decision: DecisionArtifact;
  baselineCommit: string;
  testCommit: string;
  implementationCommit: string;
  harnessDiff: string;
  implementationDiff: string;
  commandResults: unknown;
}): string {
  return `${roleHeader("verifier")}

Objective: independently try to falsify the claim that the implemented change is safe.

Directions: inspect the original contract, selected plan, B0-to-T1 harness diff, T1-to-I1 implementation diff, protected harness evidence, and deterministic results. ${RISK_DIRECTIONS} Look beyond the edited lines for affected callers, state, side effects, failures, and unrelated behavior. Identify plausible green-but-wrong behavior and require executable evidence for every contract item and protected invariant. Treat T1 test additions as the required Test Author phase, not Implementer scope; assess production scope only from T1 to I1. An expected red baseline command is evidence, not an environment defect.

Boundary: work read-only and network-off from a fresh C0 fork without the Implementer transcript. Reject unmet requirements, insufficient evidence, unplanned production scope, changed protected tests, failed commands, or a residual risk that affects required behavior. Findings must be concrete; use an empty path only for repository-wide findings.

Output: return only the schema-constrained Verification Artifact.

Verification input:
${data(input)}`;
}

export function repairPrompt(input: {
  contract: ChangeContract;
  plan: DetailedPlan;
  verification: unknown;
  protectedPaths: string[];
}): string {
  return `${roleHeader("repair")}

Objective: as the same Implementer, fix only a concrete local implementation defect identified by Verifier.

Directions: make the smallest correction inside the selected plan and report every changed path and remaining risk. If the finding originates in the contract, harness, or scope, make no code change and report that it requires re-contract, Test Author correction, or replan.

Boundary: you are the only writer and network is off. Do not broaden scope, add dependencies, rewrite history, address unrelated issues, or modify these protected harness paths:
${data(input.protectedPaths)}

Output: return only the schema-constrained Implementation Artifact after the bounded repair.

Contract:
${data(input.contract)}

Selected plan:
${data(input.plan)}

Verifier findings:
${data(input.verification)}`;
}
