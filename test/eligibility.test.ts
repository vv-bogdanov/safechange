import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePlan } from "../src/eligibility.js";
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
      safetyTests: [{ name: "not a test", proves: "AC1", argv: ["npm", "run", "typecheck"] }],
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
        },
      ],
    },
    capabilities,
  );
  assert.equal(result.eligible, false);
  assert.equal(result.failures[0]?.code, "INVALID_SAFETY_COMMAND");
});
