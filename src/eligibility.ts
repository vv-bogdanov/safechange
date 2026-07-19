import {
  authorizeRepositoryCheck,
  isCapabilityTestPath,
  type RepositoryCapabilities,
} from "./repository-capabilities.js";
import { pathWithinPrefixes } from "./repository-policy.js";
import type { ChangeContract, DetailedPlan, PlanEligibility } from "./schemas.js";

export type { PlanEligibility } from "./schemas.js";

type EligibilityFailure = PlanEligibility["failures"][number];

function missingIds(required: string[], covered: string[]): string[] {
  const coverage = new Set(covered);
  return required.filter((id) => !coverage.has(id));
}

export function evaluatePlan(
  contract: ChangeContract,
  plan: DetailedPlan,
  capabilities: RepositoryCapabilities,
): PlanEligibility {
  const failures: EligibilityFailure[] = [];
  const missingCriteria = missingIds(
    contract.acceptanceCriteria.map((item) => item.id),
    plan.acceptanceCoverage.map((item) => item.id),
  );
  if (missingCriteria.length > 0) {
    failures.push({
      code: "MISSING_ACCEPTANCE_COVERAGE",
      message: `Missing acceptance criteria: ${missingCriteria.join(", ")}`,
    });
  }

  const missingInvariants = missingIds(
    contract.protectedInvariants.map((item) => item.id),
    plan.invariantProtection.map((item) => item.id),
  );
  if (missingInvariants.length > 0) {
    failures.push({
      code: "MISSING_INVARIANT_PROTECTION",
      message: `Missing protected invariants: ${missingInvariants.join(", ")}`,
    });
  }

  const outsideScope = plan.files
    .map((file) => file.path)
    .filter((path) => !pathWithinPrefixes(path, contract.allowedPathPrefixes));
  if (outsideScope.length > 0) {
    failures.push({
      code: "OUTSIDE_ALLOWED_SCOPE",
      message: `Paths outside allowed scope: ${outsideScope.join(", ")}`,
    });
  }

  const unresolvedCritical = plan.unknowns.filter(
    (unknown) => unknown.critical && unknown.resolution.trim() === "",
  );
  if (unresolvedCritical.length > 0) {
    failures.push({
      code: "UNRESOLVED_CRITICAL_UNKNOWN",
      message: unresolvedCritical.map((unknown) => unknown.description).join("; "),
    });
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
