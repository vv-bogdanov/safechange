import type { PlanEligibility } from "./eligibility.js";
import type { RepositoryCapabilities } from "./repository-capabilities.js";
import type {
  ChangeContract,
  DecisionArtifact,
  DetailedPlan,
  EvidenceArtifact,
  HarnessArtifact,
} from "./schemas.js";

export const HIGH_ASSURANCE_DOCTRINE = `Search broadly for ways the change can fail.
Assert behavior only when grounded in the task or repository evidence.
Treat preservation of unrelated observable behavior as equal to acceptance.
Map every critical risk to executable evidence.
Stop when a critical uncertainty cannot be resolved safely.
Do not infer success from model confidence or a green suite alone.`;

const RISK_DIRECTIONS =
  "Consider applicable behavior, state, effects, failures, time, and boundary risks; justify concrete non-applicability instead of generating boilerplate.";
const CONTRACT_CALIBRATION =
  "Classify uncertainty as resolved by task/repository evidence, bounded by a conservative executable policy and therefore a critical risk, or genuinely unresolved and therefore a blocking unknown. Before emitting an unresolved critical unknown, choose the safest local policy that avoids harm and can be proven with executable tests; model that policy as acceptance/invariant plus critical risk. Block only when no such conservative policy fits the task/repository boundary and the remaining decision is human or external. Low confidence, implementation-mechanism uncertainty, or speculative external detail alone is not a critical unknown when local tests can express the safe boundary.";

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

Directions: use only the user task and validated evidence. Classify changeKind. Give criteria, invariants, non-goals, risks, and unknowns stable unique ids; connect them through existing ids in relatedIds. Give every assertion a concise task, repository, or preservation evidenceBasis with repository references where required. ${CONTRACT_CALIBRATION} Record criticality and resolution status without treating an unresolved risk as resolved. allowedPathPrefixes constrain later writes, never read-only inspection.

Boundary: work read-only and network-off. Do not convert a plausible safety failure into a non-goal, invent semantics, or omit material evidence to fit a schema bound. Surface only genuinely decision-blocking critical uncertainty as unresolved.

Output: return only the schema-constrained Change Contract.

User task:
${task}

Validated evidence:
${data(evidence)}`;
}

export function contractCorrectionPrompt(
  task: string,
  evidence: EvidenceArtifact,
  rejectedArtifact: unknown,
  feedback: PlanEligibility["failures"],
): string {
  return `${roleHeader("contract")}
[CHANGESAFELY_CORRECTION]

Objective: correct the same Change Contract artifact once after deterministic structural feedback.

Directions: address only schema shape, duplicate ids, invalid references, self references, or missing resolution evidence. Preserve all genuine requirements, risks, unknowns, criticality, and evidence relationships. A genuinely unresolved critical unknown must remain explicit and unresolved.

Boundary: work read-only and network-off. Do not broaden scope, invent semantics, delete a critical unknown, downgrade criticality, or convert a safety failure into a non-goal.

Output: return only the complete corrected Change Contract.

Gate feedback:
${data(feedback)}

User task:
${task}

Validated evidence:
${data(evidence)}

Rejected artifact:
${data(rejectedArtifact)}`;
}

export function plannerPrompt(
  planId: string,
  lens: string,
  contract: ChangeContract,
  capabilities: RepositoryCapabilities,
): string {
  return `${roleHeader("planner")}

Objective: as independent planner ${planId}, whose lens is: ${lens}, produce one self-contained admissible plan with the strongest practical evidence and smallest sufficient production delta.

Directions: map every criterion and invariant once and every critical risk in riskMitigation; preserve stable ids and evidence relationships for plan risks and unknowns. Declare all planned write paths and sensitive changes. ${RISK_DIRECTIONS} Select every safety and verification command verbatim by argv and cwd from the capability catalog; safety tests must select kind test. Record only actual new dependencies, migrations, and approval-sensitive changes. Materially apply the assigned lens without expanding scope for variety.

Boundary: work read-only. Do not edit files, invent command authority, or omit material evidence to fit a schema bound. If the lens cannot produce a safe admissible plan, say why in rejectionReasons rather than disguising the gap.

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

Directions: address only the deterministic gate feedback while preserving genuine risks, ids, evidence relationships, and sensitive changes. Questions belong in unknowns with explicit resolution status. Approval-required changes contain only changes this plan actually performs. Commands must remain verbatim catalog argv/cwd values and safety tests must select kind test.

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
  return `${roleHeader("test-author:characterization")}

Objective: add the strongest grounded characterization harness for existing behavior and protected invariants before any production change.

Directions: prefer functional checks through stable boundaries. ${RISK_DIRECTIONS} Assert only existing behavior and invariants grounded in repository evidence; do not assert the requested delta yet. Declare each executable observation in checks with stable ids, covered ids, its protected testPath, evidenceBasis, observable result or effect, expected baseline outcome, and any applicable failure or non-interference boundary. Explicitly ground whether non-interference is applicable; when it is, exercise distinct identities or operations and map them to checks. Declare the impacted production slice and a grounded branch, state-transition, and failure coverage matrix; record every known gap and whether it reaches critical behavior. Use a small test-local effect ledger when effects must be checked by identity, payload, order, or count. The targeted command must copy one selected-plan kind-test command and pass on B0. Append coverage or create focused test/fixture files without rewriting existing tests. protectedPaths must include every changed path.

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

export function changeHarnessPrompt(
  contract: ChangeContract,
  plan: DetailedPlan,
  decision: DecisionArtifact,
  characterizationCommit: string,
  characterization: HarnessArtifact,
  allowedTestPaths: string[],
  capabilities: RepositoryCapabilities,
): string {
  return `${roleHeader("test-author:change")}

Objective: continue as the same Test Author from accepted C1 and add only the separate change or regression harness for the required delta.

Directions: make the missing behavior executable through stable functional boundaries. ${RISK_DIRECTIONS} Assert only semantics grounded in the task or repository. Declare each executable observation in checks with stable ids, covered ids, its protected testPath, evidenceBasis, observable result or effect, expected baseline outcome, and any applicable failure or non-interference boundary. Resolve non-interference applicability from repository evidence; when applicable, test distinct identities or operations and map them to checks. Update the impacted-slice branch, state-transition, and failure coverage matrix with change checks; explain every known gap and mark any gap that reaches critical behavior. Exercise applicable partial failure, repetition, retry, concurrency, reentrancy, new-instance, conflict, immutability, and isolation behavior without forcing irrelevant cases. Use a small test-local effect ledger when effects must be checked by identity, payload, order, or count. The targeted command must copy one selected-plan kind-test command and fail on C1 for the intended missing behavior with an observable failure. Create separate focused test or fixture files; preserve every C1 path byte-for-byte. protectedPaths must include every newly changed path.

Boundary: you are the only writer and network is off. Change only the allowed test/fixture scope below. Do not change production code, C1 files, manifests, lockfiles, instructions, public behavior, existing test lines, or secret/config files. Do not use skip, only, weak assertions, or mocks of the behavior being proved. Stop rather than invent an unsupported oracle.

Output: return only the schema-constrained Harness Artifact after editing.

C1 commit:
${characterizationCommit}

C1 artifact:
${data(characterization)}

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
  harness: HarnessArtifact;
  harnessReview: unknown;
  commandResults: unknown;
  coverage: unknown;
}): string {
  return `${roleHeader("verifier")}

Objective: independently try to falsify the claim that the implemented change is safe.

Directions: inspect the original contract, selected plan, B0-to-T1 harness diff, T1-to-I1 implementation diff, protected harness and H1 evidence, scoped baseline/final coverage evidence, and deterministic results. Reconstruct every acceptance criterion, protected invariant, and critical risk through its harness check to passed command evidence. ${RISK_DIRECTIONS} Look beyond the edited lines for affected callers, state, side effects, failures, and unrelated behavior. Identify plausible green-but-wrong behavior and require executable evidence for it. Treat T1 test additions as the required Test Author phase, not Implementer scope; assess production scope only from T1 to I1. An expected red baseline command is evidence, not an environment defect. Treat a coverage matrix as explicit behavioral evidence, and numeric coverage only as supporting evidence.

Boundary: work read-only and network-off from a fresh C0 fork without the Implementer transcript. Reject unmet requirements, incomplete traceability, insufficient evidence, unplanned production scope, changed protected tests, failed commands, or any unresolved risk affecting acceptance, an invariant, or a critical risk. An accepted verdict must have no findings or residual risks. Classify a repairable local production defect with code IMPLEMENTATION_DEFECT; use CONTRACT_DEFECT, HARNESS_DEFECT, SCOPE_DEFECT, or EVIDENCE_DEFECT for findings that must not enter Implementer repair. Findings must be concrete; use an empty path only for repository-wide findings.

Output: return only the schema-constrained Verification Artifact.

Verification input:
${data(input)}`;
}

export function harnessVerifierPrompt(input: {
  contract: ChangeContract;
  plan: DetailedPlan;
  decision: DecisionArtifact;
  baselineCommit: string;
  characterizationCommit: string;
  testCommit: string;
  characterizationDiff: string;
  changeDiff: string;
  harness: HarnessArtifact;
  protectedPaths: string[];
  coverage: unknown;
  commandResults: unknown;
}): string {
  return `${roleHeader("verifier:harness")}

Objective: independently try to falsify the claim that the protected harness is sufficient before production implementation starts.

Directions: review assertion provenance, critical-risk mappings, preservation and non-interference, failure and temporal boundaries, invented or over-constrained semantics, and unexplained coverage gaps. ${RISK_DIRECTIONS} Propose plausible green-but-wrong implementations and name the existing executable check id that would reject each one; reject when a plausible required failure has no grounded check. Treat numeric coverage only as supporting evidence.

Boundary: work read-only and network-off from a fresh C0 fork without Test Author or future Implementer transcripts. Reject unsupported assertions, missing critical evidence, weakened protected behavior, or a correction that would require rewriting an existing protected path. Findings must name the affected protected test path when one exists.

Output: return only the schema-constrained Verification Artifact. Accept only when the harness is grounded, complete for critical behavior, and capable of rejecting the plausible unsafe implementations you identified.

Harness review input:
${data(input)}`;
}

export function harnessCorrectionPrompt(input: {
  contract: ChangeContract;
  plan: DetailedPlan;
  review: unknown;
  harness: HarnessArtifact;
  immutablePaths: string[];
  allowedTestScopes: string[];
}): string {
  return `${roleHeader("test-author:correction")}

Objective: as the same Test Author, add the smallest grounded executable evidence requested by the independent harness review.

Directions: add focused functional tests or fixtures only. Preserve the current harness outcome and provide new stable check ids, traceability, assertion basis, non-interference evidence, and coverage mappings. Do not add speculative cases beyond the contract or repository evidence.

Boundary: you are the only writer and network is off. Append new test evidence only inside the allowed test scopes. Do not edit, delete, rename, or weaken any existing protected path, production path, manifest, lockfile, instruction, or configuration. If the review requires invented semantics or changing protected evidence, make no change and return the blocking gap.

Output: after editing, return only the schema-constrained Harness Artifact for the new correction delta.

Canonical contract:
${data(input.contract)}

Selected plan:
${data(input.plan)}

Current protected harness:
${data(input.harness)}

Independent review:
${data(input.review)}

Immutable paths:
${data(input.immutablePaths)}

Allowed correction scopes:
${data(input.allowedTestScopes)}`;
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
