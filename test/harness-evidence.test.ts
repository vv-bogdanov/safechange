import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHarnessEvidence } from "../src/harness-evidence.js";
import type { HarnessArtifact } from "../src/schemas.js";
import { validContract, validHarness, validPlan } from "./support/artifacts.js";

function changeHarness(): HarnessArtifact {
  return validHarness({
    summary: "Added executable change evidence.",
    testPaths: ["test/value.test.ts"],
    targetedCommand: {
      name: "targeted change",
      argv: ["npm", "test"],
      cwd: ".",
      purpose: "Prove the requested behavior is absent on baseline",
    },
    expectedBaselineOutcome: "fail",
    expectedFailure: "The requested value is absent.",
    checks: [
      {
        id: "CHK-AC1",
        kind: "change",
        testPath: "test/value.test.ts",
        coveredCriteriaIds: ["AC1"],
        coveredInvariantIds: [],
        coveredRiskIds: [],
        observable: "The requested value is returned.",
        evidenceBasis: [
          { source: "task", detail: "The requested value is explicit.", references: [] },
        ],
        expectedBaselineOutcome: "fail",
        failureBoundary: "",
        nonInterferenceTarget: "",
      },
    ],
    protectedPaths: ["test/value.test.ts"],
  });
}

function finalHarness(): HarnessArtifact {
  const characterization = validHarness();
  const change = changeHarness();
  return {
    ...change,
    checks: [...characterization.checks, ...change.checks],
    testPaths: [...characterization.testPaths, ...change.testPaths],
    protectedPaths: [...characterization.protectedPaths, ...change.protectedPaths],
  };
}

test("accepts valid characterization and final risk mappings", () => {
  assert.deepEqual(
    evaluateHarnessEvidence(validContract(), validPlan(), validHarness(), {
      stage: "characterization",
    }),
    [],
  );
  assert.deepEqual(
    evaluateHarnessEvidence(validContract(), validPlan(), finalHarness(), { final: true }),
    [],
  );
});

test("rejects missing and unknown harness relationships", () => {
  const harness = finalHarness();
  const characterization = harness.checks[0];
  const change = harness.checks[1];
  assert.ok(characterization);
  assert.ok(change);
  characterization.coveredInvariantIds = [];
  characterization.coveredRiskIds = ["R404"];
  change.coveredCriteriaIds = [];

  assert.deepEqual(
    evaluateHarnessEvidence(validContract(), validPlan(), harness, { final: true }).map(
      (failure) => failure.code,
    ),
    [
      "UNKNOWN_HARNESS_RISK",
      "MISSING_HARNESS_INVARIANT",
      "MISSING_HARNESS_CRITERION",
      "MISSING_HARNESS_CRITICAL_RISK",
    ],
  );
});

test("rejects harness ids placed in the wrong coverage bucket", () => {
  const contract = validContract({
    nonGoals: [
      {
        id: "NG1",
        statement: "Do not change deployment behavior.",
        evidenceBasis: [
          { source: "task", detail: "The task is repository-local.", references: [] },
        ],
        relatedRiskIds: ["R1"],
      },
    ],
  });
  const harness = validHarness();
  const check = harness.checks[0];
  assert.ok(check);
  check.coveredCriteriaIds = ["INV1", "NG1"];
  check.coveredInvariantIds = ["AC1"];
  check.coveredRiskIds = ["NG1"];

  assert.deepEqual(
    evaluateHarnessEvidence(contract, validPlan(), harness, { stage: "characterization" }).map(
      (failure) => failure.code,
    ),
    [
      "UNKNOWN_HARNESS_CRITERION",
      "UNKNOWN_HARNESS_INVARIANT",
      "UNKNOWN_HARNESS_RISK",
      "MISSING_HARNESS_INVARIANT",
    ],
  );
});

test("requires an executable non-interference assertion when shared state is applicable", () => {
  const harness = validHarness({
    nonInterference: {
      status: "applicable",
      targets: ["tenant B"],
      checkIds: ["CHK-INV1"],
      evidenceBasis: [
        {
          source: "repository",
          detail: "The component shares a tenant-keyed store.",
          references: [{ path: "src/value.ts", detail: "Shared store boundary." }],
        },
      ],
    },
  });

  assert.deepEqual(
    evaluateHarnessEvidence(validContract(), validPlan(), harness, {
      stage: "characterization",
    }).map((failure) => failure.code),
    ["NON_INTERFERENCE_ASSERTION_MISSING"],
  );

  const check = harness.checks[0];
  assert.ok(check);
  check.nonInterferenceTarget = "A tenant A call cannot affect tenant B state.";
  assert.deepEqual(
    evaluateHarnessEvidence(validContract(), validPlan(), harness, {
      stage: "characterization",
    }),
    [],
  );
});

test("blocks unresolved non-interference applicability", () => {
  const harness = validHarness({
    nonInterference: {
      ...validHarness().nonInterference,
      status: "unknown",
    },
  });
  assert.equal(
    evaluateHarnessEvidence(validContract(), validPlan(), harness)[0]?.code,
    "NON_INTERFERENCE_UNRESOLVED",
  );
});
