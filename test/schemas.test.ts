import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactValidationError,
  changeContractSchema,
  decisionArtifactSchema,
  detailedPlanSchema,
  evidenceArtifactSchema,
  harnessArtifactSchema,
  implementationArtifactSchema,
  LEGACY_ARTIFACT_VERSION,
  smokeArtifactSchema,
  validateChangeContract,
  validateCommandEvidenceList,
  validateDetailedPlan,
  validatePersistedDetailedPlan,
  validatePlanEligibilityList,
  validateSmokeArtifact,
  verificationArtifactSchema,
} from "../src/schemas.js";
import { validContract, validPlan } from "./support/artifacts.js";

test("accepts a valid structured artifact", () => {
  assert.deepEqual(validateSmokeArtifact({ kind: "smoke", message: "ready" }), {
    kind: "smoke",
    message: "ready",
  });
});

test("rejects malformed structured artifacts", () => {
  assert.throws(
    () => validateSmokeArtifact({ kind: "smoke", message: "" }),
    ArtifactValidationError,
  );
});

test("role output schemas satisfy strict Structured Outputs", () => {
  for (const schema of [
    smokeArtifactSchema,
    evidenceArtifactSchema,
    changeContractSchema,
    detailedPlanSchema,
    decisionArtifactSchema,
    harnessArtifactSchema,
    implementationArtifactSchema,
    verificationArtifactSchema,
  ]) {
    assertStrictObjectPropertiesRequired(schema);
  }
});

test("validates persisted deterministic evidence", () => {
  assert.equal(
    validatePlanEligibilityList([
      {
        planId: "plan-1",
        eligible: true,
        failures: [],
        humanDecisionReasons: [],
      },
    ])[0]?.planId,
    "plan-1",
  );
  assert.throws(
    () =>
      validateCommandEvidenceList([
        {
          commandId: "command-1",
          command: "npm test",
          argv: ["npm", "test"],
          cwd: ".",
          startedAt: "2026-07-19T00:00:00.000Z",
          completedAt: "2026-07-19T00:00:00.001Z",
          exitCode: 0,
          signal: null,
          timedOut: false,
          sandboxed: true,
          durationMs: -1,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutSha256: "a".repeat(64),
          stderrSha256: "b".repeat(64),
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ]),
    ArtifactValidationError,
  );
});

test("requires grounded contract assertions and supported non-goals", () => {
  const missingBasis = structuredClone(validContract()) as Record<string, unknown> & {
    acceptanceCriteria: Array<Record<string, unknown>>;
  };
  delete missingBasis.acceptanceCriteria[0]?.evidenceBasis;
  assert.throws(() => validateChangeContract(missingBasis), ArtifactValidationError);

  const unsupportedNonGoal = {
    ...validContract(),
    nonGoals: [
      {
        id: "NG1",
        statement: "Ignore a plausible preservation failure.",
        evidenceBasis: [
          {
            source: "preservation",
            detail: "No task or repository basis supports this exclusion.",
            references: [],
          },
        ],
        relatedRiskIds: ["R1"],
      },
    ],
  };
  assert.throws(() => validateChangeContract(unsupportedNonGoal), ArtifactValidationError);
});

test("accepts realistic high-risk artifact sizes without truncation", () => {
  const criteria = Array.from({ length: 24 }, (_, index) => ({
    id: `AC${index + 1}`,
    statement: `Observable requirement ${index + 1}.`,
    evidenceBasis: [
      { source: "task" as const, detail: "Explicit task requirement.", references: [] },
    ],
  }));
  const contract = validateChangeContract(
    validContract({
      acceptanceCriteria: criteria,
      allowedPathPrefixes: Array.from({ length: 24 }, (_, index) => `package-${index + 1}`),
      risks: Array.from({ length: 24 }, (_, index) => ({
        id: `R${index + 1}`,
        statement: `Risk ${index + 1}.`,
        critical: index === 0,
        resolutionStatus: "unresolved" as const,
        resolution: "",
        relatedIds: [criteria[index]?.id ?? "AC1"],
        evidenceBasis: [
          { source: "task" as const, detail: "Risk follows from the task.", references: [] },
        ],
      })),
    }),
  );
  const plan = validateDetailedPlan(
    validPlan({
      acceptanceCoverage: criteria.map((item) => ({ id: item.id, strategy: "Verify it." })),
      files: Array.from({ length: 24 }, (_, index) => ({
        path: `package-${index + 1}/value.ts`,
        purpose: "Bounded change.",
      })),
    }),
  );

  assert.equal(contract.acceptanceCriteria.length, 24);
  assert.equal(contract.risks.length, 24);
  assert.equal(plan.files.length, 24);
});

test("normalizes legacy plan unknowns through the artifact v2 compatibility path", () => {
  const current = validPlan();
  const legacy = {
    ...current,
    risks: ["Legacy risk."],
    unknowns: [{ description: "Legacy question.", critical: true, resolution: "" }],
  } as Record<string, unknown>;
  delete legacy.riskMitigation;
  const migrated = validatePersistedDetailedPlan(legacy, LEGACY_ARTIFACT_VERSION);

  assert.equal(migrated.risks[0]?.id, "PR1");
  assert.equal(migrated.unknowns[0]?.resolutionStatus, "unresolved");
});

function assertStrictObjectPropertiesRequired(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertStrictObjectPropertiesRequired(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object" && isRecord(schema.properties)) {
    assert.deepEqual(
      new Set(Array.isArray(schema.required) ? schema.required : []),
      new Set(Object.keys(schema.properties)),
    );
  }
  for (const nested of Object.values(schema)) assertStrictObjectPropertiesRequired(nested);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
