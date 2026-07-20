import assert from "node:assert/strict";
import test from "node:test";
import { evaluateContract, evaluatePlan } from "../src/eligibility.js";
import type { RepositoryCapabilities } from "../src/repository-capabilities.js";
import { validatePlanEligibilityList } from "../src/schemas.js";
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
          relatedIds: ["INV1"],
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

test("accepts natural contract relationship links across known contract ids", () => {
  const result = evaluateContract(
    validContract({
      nonGoals: [
        {
          id: "NG1",
          statement: "Do not change the deployment policy.",
          evidenceBasis: [
            { source: "task", detail: "The task is limited to local behavior.", references: [] },
          ],
          relatedRiskIds: ["R1"],
        },
      ],
      risks: [
        {
          id: "R1",
          statement: "The local change may need to bound an unknown deployment interaction.",
          critical: true,
          resolutionStatus: "unresolved",
          resolution: "",
          relatedIds: ["AC1", "INV1", "U1", "NG1"],
          evidenceBasis: [
            {
              source: "repository",
              detail: "The implementation serves the required and preserved behavior.",
              references: [{ path: "src/value.ts", detail: "Shared implementation boundary." }],
            },
          ],
        },
      ],
      unknowns: [
        {
          id: "U1",
          statement: "The exact deployment topology is not relevant to the local proof.",
          critical: false,
          resolutionStatus: "resolved",
          resolution: "The contract bounds this through R1 and local executable evidence.",
          relatedIds: ["R1", "NG1"],
          evidenceBasis: [
            {
              source: "repository",
              detail: "The repository exposes a local behavior boundary.",
              references: [{ path: "src/value.ts", detail: "Local behavior boundary." }],
            },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(result, []);
});

test("rejects unknown and self contract relationship links", () => {
  const baseRisk = contract.risks[0];
  assert.ok(baseRisk);

  assert.deepEqual(
    evaluateContract(
      validContract({
        risks: [
          {
            ...baseRisk,
            relatedIds: ["AC1", "MISSING"],
          },
        ],
      }),
    ).map((failure) => failure.code),
    ["UNKNOWN_CONTRACT_REFERENCE"],
  );

  assert.deepEqual(
    evaluateContract(
      validContract({
        risks: [
          {
            ...baseRisk,
            relatedIds: ["R1"],
          },
        ],
      }),
    ).map((failure) => failure.code),
    ["SELF_CONTRACT_REFERENCE"],
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

test("keeps long eligibility diagnostics artifact-valid", () => {
  const paths = Array.from(
    { length: 12 },
    (_, index) => `unexpected/deeply-nested-legacy-entrypoint-${index}-with-extra-context.js`,
  );
  const result = evaluatePlan(
    contract,
    validPlan({
      files: paths.map((path) => ({ path, purpose: "Out-of-scope diagnostic fixture" })),
      steps: [{ id: "S1", description: "Touch many out-of-scope paths.", paths }],
    }),
    capabilities,
  );

  const outsideScope = result.failures.find((failure) => failure.code === "OUTSIDE_ALLOWED_SCOPE");
  assert.ok(outsideScope);
  assert.equal(outsideScope.message.length, 400);
  assert.match(outsideScope.message, /\.\.\.$/u);
  assert.equal(result.eligible, false);
  validatePlanEligibilityList([result]);
});

test("accepts natural plan relationship links without weakening coverage ids", () => {
  const linkedContract = validContract({
    nonGoals: [
      {
        id: "NG1",
        statement: "Do not change deployment policy.",
        evidenceBasis: [
          { source: "task", detail: "The task is limited to local behavior.", references: [] },
        ],
        relatedRiskIds: ["R1"],
      },
    ],
    unknowns: [
      {
        id: "U1",
        statement: "Deployment topology is not required for the local implementation.",
        critical: false,
        resolutionStatus: "resolved",
        resolution: "The local implementation boundary is enough for this plan.",
        relatedIds: ["R1", "NG1"],
        evidenceBasis: [
          {
            source: "repository",
            detail: "The repository exposes the local behavior boundary.",
            references: [{ path: "src/value.ts", detail: "Local behavior boundary." }],
          },
        ],
      },
    ],
  });
  const linkedPlan = validPlan({
    risks: [
      {
        id: "PR1",
        statement: "The implementation may affect the locally bounded deployment concern.",
        critical: false,
        resolutionStatus: "unresolved",
        resolution: "",
        relatedIds: ["R1", "U1", "NG1"],
        evidenceBasis: [
          {
            source: "repository",
            detail: "The implementation path is shared.",
            references: [{ path: "src/value.ts", detail: "Planned production edit." }],
          },
        ],
      },
    ],
    unknowns: [
      {
        id: "PU1",
        statement: "The plan does not need the exact deployment topology.",
        critical: false,
        resolutionStatus: "resolved",
        resolution: "It is bounded by PR1 and repository-local checks.",
        relatedIds: ["PR1", "NG1"],
        evidenceBasis: [
          {
            source: "repository",
            detail: "The planned checks run at the local behavior boundary.",
            references: [{ path: "test/value.test.ts", detail: "Planned acceptance check." }],
          },
        ],
      },
    ],
  });

  assert.deepEqual(evaluatePlan(linkedContract, linkedPlan, capabilities), {
    planId: "plan-1",
    eligible: true,
    failures: [],
    humanDecisionReasons: [],
  });

  assert.deepEqual(
    evaluatePlan(
      linkedContract,
      { ...linkedPlan, acceptanceCoverage: [{ id: "U1", strategy: "Not executable coverage." }] },
      capabilities,
    ).failures.map((failure) => failure.code),
    ["MISSING_ACCEPTANCE_COVERAGE", "UNKNOWN_COVERAGE_ID"],
  );
});

test("rejects unknown and self plan relationship links", () => {
  const basePlanRisk = plan.risks[0];
  assert.ok(basePlanRisk);

  assert.deepEqual(
    evaluatePlan(
      contract,
      {
        ...plan,
        risks: [
          {
            ...basePlanRisk,
            relatedIds: ["AC1", "MISSING"],
          },
        ],
      },
      capabilities,
    ).failures.map((failure) => failure.code),
    ["UNKNOWN_PLAN_REFERENCE"],
  );

  assert.deepEqual(
    evaluatePlan(
      contract,
      {
        ...plan,
        unknowns: [
          {
            id: "PU1",
            statement: "The plan unknown points to itself.",
            critical: false,
            resolutionStatus: "resolved",
            resolution: "Invalid relationship fixture.",
            relatedIds: ["PU1"],
            evidenceBasis: [
              {
                source: "repository",
                detail: "The implementation has a local boundary.",
                references: [{ path: "src/value.ts", detail: "Local boundary." }],
              },
            ],
          },
        ],
      },
      capabilities,
    ).failures.map((failure) => failure.code),
    ["SELF_PLAN_REFERENCE"],
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
