import assert from "node:assert/strict";
import test from "node:test";
import { evaluateContract, evaluatePlan } from "../src/eligibility.js";
import type { RepositoryCapabilities } from "../src/repository-capabilities.js";
import { validContract, validPlan } from "./support/artifacts.js";

const contract = validContract();
const plan = validPlan();
const capabilities: RepositoryCapabilities = {
  checks: [
    { id: "npm:.:test", kind: "test", argv: ["npm", "test"], cwd: "." },
    {
      id: "npm:.:typecheck",
      kind: "typecheck",
      argv: ["npm", "run", "typecheck"],
      cwd: ".",
    },
  ],
  testPathPrefixes: ["test", "tests", "spec", "__tests__"],
  testFilePatterns: ["*.test.*", "*.spec.*"],
  controlFiles: ["package.json"],
  sources: ["npm:package.json"],
};

test("accepts a complete in-scope plan", () => {
  assert.deepEqual(evaluatePlan(contract, plan, capabilities), {
    planId: "plan-1",
    eligible: true,
    failures: [],
    humanDecisionReasons: [],
  });
});

test("rejects unresolved critical contract uncertainty and duplicate ids", () => {
  const result = evaluateContract(
    validContract({
      unknowns: [
        {
          id: "AC1",
          statement: "Failure behavior is not defined.",
          critical: true,
          resolutionStatus: "unresolved",
          resolution: "",
          relatedIds: ["AC1"],
          evidenceBasis: [
            { source: "task", detail: "The task leaves failure behavior open.", references: [] },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(
    result.map((failure) => failure.code),
    ["DUPLICATE_CONTRACT_ID", "UNRESOLVED_CRITICAL_CONTRACT_UNKNOWN"],
  );
});

test("rejects missing critical risk mitigation and unknown coverage ids", () => {
  const result = evaluatePlan(
    contract,
    {
      ...plan,
      riskMitigation: [{ id: "R404", strategy: "An unrelated strategy." }],
    },
    capabilities,
  );

  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["MISSING_CRITICAL_RISK_MITIGATION", "UNKNOWN_COVERAGE_ID"],
  );
});

test("rejects an unresolved critical plan unknown", () => {
  const result = evaluatePlan(
    contract,
    {
      ...plan,
      unknowns: [
        {
          id: "PU1",
          statement: "The side-effect policy is unknown.",
          critical: true,
          resolutionStatus: "unresolved",
          resolution: "",
          relatedIds: ["R1"],
          evidenceBasis: [
            {
              source: "repository",
              detail: "The implementation has an undocumented effect boundary.",
              references: [{ path: "src/value.ts", detail: "Effect boundary." }],
            },
          ],
        },
      ],
    },
    capabilities,
  );

  assert.equal(result.failures.at(-1)?.code, "UNRESOLVED_CRITICAL_UNKNOWN");
});

test("rejects missing coverage and paths outside scope", () => {
  const result = evaluatePlan(
    contract,
    {
      ...plan,
      acceptanceCoverage: [],
      files: [{ path: "infra/prod.tf", purpose: "Unexpected" }],
    },
    capabilities,
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["MISSING_ACCEPTANCE_COVERAGE", "OUTSIDE_ALLOWED_SCOPE"],
  );
});

test("requires human approval for a dependency", () => {
  const result = evaluatePlan(contract, { ...plan, dependencies: ["new-package"] }, capabilities);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.humanDecisionReasons, ["Dependency: new-package"]);
});

test("rejects a safety check that does not execute tests", () => {
  const result = evaluatePlan(
    contract,
    {
      ...plan,
      safetyTests: [
        {
          name: "not a test",
          proves: "AC1",
          argv: ["npm", "run", "typecheck"],
          cwd: ".",
        },
      ],
    },
    capabilities,
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["INVALID_SAFETY_COMMAND"],
  );
});

test("rejects a plan without a declared safety harness path", () => {
  const result = evaluatePlan(
    contract,
    {
      ...plan,
      files: [{ path: "src/value.ts", purpose: "Implementation" }],
      steps: [{ id: "S1", description: "Implement the behavior.", paths: ["src/value.ts"] }],
    },
    capabilities,
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["MISSING_TEST_PATH"],
  );
});

test("rejects a direct source test command outside the npm MVP contract", () => {
  const result = evaluatePlan(
    contract,
    {
      ...plan,
      safetyTests: [
        {
          name: "direct source test",
          proves: "AC1",
          argv: ["node", "--test", "test/value.test.ts"],
          cwd: ".",
        },
      ],
    },
    capabilities,
  );
  assert.equal(result.eligible, false);
  assert.equal(result.failures[0]?.code, "INVALID_SAFETY_COMMAND");
});
