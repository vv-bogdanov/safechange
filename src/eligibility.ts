import {
  authorizeRepositoryCheck,
  isCapabilityTestPath,
  type RepositoryCapabilities,
} from "./repository-capabilities.js";
import { pathWithinPrefixes } from "./repository-policy.js";
import type { ChangeContract, DetailedPlan, PlanEligibility } from "./schemas.js";

export type { PlanEligibility } from "./schemas.js";

export type EligibilityFailure = PlanEligibility["failures"][number];

function addFailure(failures: EligibilityFailure[], code: string, message: string): void {
  failures.push({ code, message });
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

function unknownIds(actual: string[], known: Set<string>): string[] {
  return [...new Set(actual.filter((id) => !known.has(id)))];
}

function missingIds(required: string[], covered: string[]): string[] {
  const coverage = new Set(covered);
  return required.filter((id) => !coverage.has(id));
}

export function evaluateContract(contract: ChangeContract): EligibilityFailure[] {
  const failures: EligibilityFailure[] = [];
  const requirementIds = [
    ...contract.acceptanceCriteria.map((item) => item.id),
    ...contract.protectedInvariants.map((item) => item.id),
  ];
  const riskIds = contract.risks.map((item) => item.id);
  const allIds = [
    ...requirementIds,
    ...contract.nonGoals.map((item) => item.id),
    ...riskIds,
    ...contract.unknowns.map((item) => item.id),
  ];
  const duplicates = duplicateIds(allIds);
  if (duplicates.length > 0) {
    addFailure(
      failures,
      "DUPLICATE_CONTRACT_ID",
      `Duplicate contract ids: ${duplicates.join(", ")}`,
    );
  }

  const requirementIdSet = new Set(requirementIds);
  const invalidRiskLinks = contract.risks.flatMap((risk) =>
    unknownIds(risk.relatedIds, requirementIdSet).map((id) => `${risk.id}->${id}`),
  );
  const knownContractIds = new Set([...requirementIds, ...riskIds]);
  const invalidUnknownLinks = contract.unknowns.flatMap((unknown) =>
    unknownIds(unknown.relatedIds, knownContractIds).map((id) => `${unknown.id}->${id}`),
  );
  const invalidNonGoalLinks = contract.nonGoals.flatMap((nonGoal) =>
    unknownIds(nonGoal.relatedRiskIds, new Set(riskIds)).map((id) => `${nonGoal.id}->${id}`),
  );
  const invalidLinks = [...invalidRiskLinks, ...invalidUnknownLinks, ...invalidNonGoalLinks];
  if (invalidLinks.length > 0) {
    addFailure(
      failures,
      "UNKNOWN_CONTRACT_REFERENCE",
      `Unknown contract relationships: ${invalidLinks.join(", ")}`,
    );
  }

  const incompleteRisks = contract.risks.filter(
    (risk) => risk.resolutionStatus === "mitigated" && risk.resolution.trim() === "",
  );
  if (incompleteRisks.length > 0) {
    addFailure(
      failures,
      "INVALID_RISK_RESOLUTION",
      `Mitigated risks require evidence: ${incompleteRisks.map((risk) => risk.id).join(", ")}`,
    );
  }

  const incompleteUnknowns = contract.unknowns.filter(
    (unknown) => unknown.resolutionStatus === "resolved" && unknown.resolution.trim() === "",
  );
  if (incompleteUnknowns.length > 0) {
    addFailure(
      failures,
      "INVALID_UNKNOWN_RESOLUTION",
      `Resolved unknowns require evidence: ${incompleteUnknowns
        .map((unknown) => unknown.id)
        .join(", ")}`,
    );
  }

  const unresolvedCritical = contract.unknowns.filter(
    (unknown) => unknown.critical && unknown.resolutionStatus === "unresolved",
  );
  if (unresolvedCritical.length > 0) {
    addFailure(
      failures,
      "UNRESOLVED_CRITICAL_CONTRACT_UNKNOWN",
      `Unresolved critical contract unknowns: ${unresolvedCritical
        .map((unknown) => unknown.id)
        .join(", ")}`,
    );
  }
  return failures;
}

export function evaluatePlan(
  contract: ChangeContract,
  plan: DetailedPlan,
  capabilities: RepositoryCapabilities,
): PlanEligibility {
  const failures: EligibilityFailure[] = [...evaluateContract(contract)];
  const acceptanceIds = contract.acceptanceCriteria.map((item) => item.id);
  const invariantIds = contract.protectedInvariants.map((item) => item.id);
  const criticalRiskIds = contract.risks.filter((risk) => risk.critical).map((risk) => risk.id);
  const missingCriteria = missingIds(
    acceptanceIds,
    plan.acceptanceCoverage.map((item) => item.id),
  );
  if (missingCriteria.length > 0) {
    failures.push({
      code: "MISSING_ACCEPTANCE_COVERAGE",
      message: `Missing acceptance criteria: ${missingCriteria.join(", ")}`,
    });
  }

  const missingInvariants = missingIds(
    invariantIds,
    plan.invariantProtection.map((item) => item.id),
  );
  if (missingInvariants.length > 0) {
    failures.push({
      code: "MISSING_INVARIANT_PROTECTION",
      message: `Missing protected invariants: ${missingInvariants.join(", ")}`,
    });
  }

  const missingRiskMitigation = missingIds(
    criticalRiskIds,
    plan.riskMitigation.map((item) => item.id),
  );
  if (missingRiskMitigation.length > 0) {
    addFailure(
      failures,
      "MISSING_CRITICAL_RISK_MITIGATION",
      `Missing critical risk mitigation: ${missingRiskMitigation.join(", ")}`,
    );
  }

  const coverageRelationships = [
    ...plan.acceptanceCoverage.map((item) => ({ kind: "acceptance", ...item })),
    ...plan.invariantProtection.map((item) => ({ kind: "invariant", ...item })),
    ...plan.riskMitigation.map((item) => ({ kind: "risk", ...item })),
  ];
  const knownCoverageIds = new Set([
    ...acceptanceIds,
    ...invariantIds,
    ...contract.risks.map((r) => r.id),
  ]);
  const invalidCoverageIds = unknownIds(
    coverageRelationships.map((item) => item.id),
    knownCoverageIds,
  );
  const duplicateCoverageIds = duplicateIds(coverageRelationships.map((item) => item.id));
  if (invalidCoverageIds.length > 0) {
    addFailure(
      failures,
      "UNKNOWN_COVERAGE_ID",
      `Coverage references unknown contract ids: ${invalidCoverageIds.join(", ")}`,
    );
  }
  if (duplicateCoverageIds.length > 0) {
    addFailure(
      failures,
      "DUPLICATE_COVERAGE_ID",
      `Coverage ids must be mapped once: ${duplicateCoverageIds.join(", ")}`,
    );
  }

  const outsideScope = [
    ...plan.files.map((file) => file.path),
    ...plan.steps.flatMap((step) => step.paths),
  ].filter((path) => !pathWithinPrefixes(path, contract.allowedPathPrefixes));
  if (outsideScope.length > 0) {
    failures.push({
      code: "OUTSIDE_ALLOWED_SCOPE",
      message: `Paths outside allowed scope: ${outsideScope.join(", ")}`,
    });
  }

  const planIds = [
    ...plan.risks.map((risk) => risk.id),
    ...plan.unknowns.map((unknown) => unknown.id),
  ];
  const duplicatePlanIds = duplicateIds(planIds);
  if (duplicatePlanIds.length > 0) {
    addFailure(
      failures,
      "DUPLICATE_PLAN_ID",
      `Duplicate plan risk or unknown ids: ${duplicatePlanIds.join(", ")}`,
    );
  }
  const contractIds = new Set([
    ...knownCoverageIds,
    ...contract.nonGoals.map((item) => item.id),
    ...contract.unknowns.map((item) => item.id),
  ]);
  const collidingPlanIds = [...new Set(planIds.filter((id) => contractIds.has(id)))];
  if (collidingPlanIds.length > 0) {
    addFailure(
      failures,
      "PLAN_ID_COLLISION",
      `Plan ids collide with contract ids: ${collidingPlanIds.join(", ")}`,
    );
  }
  const knownPlanRelationships = new Set([
    ...knownCoverageIds,
    ...plan.risks.map((risk) => risk.id),
  ]);
  const invalidPlanLinks = [...plan.risks, ...plan.unknowns].flatMap((item) =>
    unknownIds(item.relatedIds, knownPlanRelationships).map((id) => `${item.id}->${id}`),
  );
  if (invalidPlanLinks.length > 0) {
    addFailure(
      failures,
      "UNKNOWN_PLAN_REFERENCE",
      `Unknown plan relationships: ${invalidPlanLinks.join(", ")}`,
    );
  }
  const incompletePlanRisks = plan.risks.filter(
    (risk) => risk.resolutionStatus === "mitigated" && risk.resolution.trim() === "",
  );
  if (incompletePlanRisks.length > 0) {
    addFailure(
      failures,
      "INVALID_PLAN_RISK_RESOLUTION",
      `Mitigated plan risks require evidence: ${incompletePlanRisks
        .map((risk) => risk.id)
        .join(", ")}`,
    );
  }
  const unresolvedCritical = plan.unknowns.filter(
    (unknown) => unknown.critical && unknown.resolutionStatus === "unresolved",
  );
  if (unresolvedCritical.length > 0) {
    failures.push({
      code: "UNRESOLVED_CRITICAL_UNKNOWN",
      message: unresolvedCritical.map((unknown) => unknown.id).join(", "),
    });
  }
  const invalidResolvedUnknowns = plan.unknowns.filter(
    (unknown) => unknown.resolutionStatus === "resolved" && unknown.resolution.trim() === "",
  );
  if (invalidResolvedUnknowns.length > 0) {
    addFailure(
      failures,
      "INVALID_PLAN_UNKNOWN_RESOLUTION",
      `Resolved plan unknowns require evidence: ${invalidResolvedUnknowns
        .map((unknown) => unknown.id)
        .join(", ")}`,
    );
  }

  if (plan.safetyTests.length === 0 || plan.verificationCommands.length === 0) {
    failures.push({
      code: "MISSING_VERIFICATION_STRATEGY",
      message: "Plan requires safety tests and deterministic verification commands",
    });
  }
  const plannedPaths = new Set([
    ...plan.files.map((file) => file.path),
    ...plan.steps.flatMap((step) => step.paths),
  ]);
  if (![...plannedPaths].some((path) => isCapabilityTestPath(capabilities, path))) {
    failures.push({
      code: "MISSING_TEST_PATH",
      message: "Plan does not declare a repository test path for the safety harness",
    });
  }
  const invalidSafetyCommands = plan.safetyTests.filter(
    (test) => !authorizeRepositoryCheck(capabilities, test.argv, test.cwd ?? ".", "test"),
  );
  if (invalidSafetyCommands.length > 0) {
    failures.push({
      code: "INVALID_SAFETY_COMMAND",
      message: `Safety checks must run tests: ${invalidSafetyCommands
        .map((test) => test.argv.join(" "))
        .join("; ")}`,
    });
  }
  const invalidVerificationCommands = plan.verificationCommands.filter(
    (command) => !authorizeRepositoryCheck(capabilities, command.argv, command.cwd ?? "."),
  );
  if (invalidVerificationCommands.length > 0) {
    failures.push({
      code: "INVALID_VERIFICATION_COMMAND",
      message: `Verification checks are outside the baseline catalog: ${invalidVerificationCommands
        .map((command) => `${command.cwd ?? "."}: ${command.argv.join(" ")}`)
        .join("; ")}`,
    });
  }
  if (plan.recovery.length === 0) {
    failures.push({
      code: "MISSING_RECOVERY",
      message: "Plan does not define a recovery path",
    });
  }

  const humanDecisionReasons = [
    ...plan.approvalRequiredChanges,
    ...plan.dependencies.map((item) => `Dependency: ${item}`),
    ...plan.migrations.map((item) => `Migration: ${item}`),
  ];

  return {
    planId: plan.planId,
    eligible: failures.length === 0 && humanDecisionReasons.length === 0,
    failures,
    humanDecisionReasons,
  };
}

export function evaluatePlans(
  contract: ChangeContract,
  plans: DetailedPlan[],
  capabilities: RepositoryCapabilities,
): PlanEligibility[] {
  return plans.map((plan) => evaluatePlan(contract, plan, capabilities));
}
