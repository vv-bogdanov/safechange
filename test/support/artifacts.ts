import type { ChangeContract, DetailedPlan, EvidenceArtifact } from "../../src/schemas.js";

export function validEvidence(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return {
    summary: "Fixture repository",
    facts: [],
    commands: [],
    testGaps: [],
    constraints: [],
    assumptions: [],
    unknowns: [],
    ...overrides,
  };
}

export function validContract(overrides: Partial<ChangeContract> = {}): ChangeContract {
  return {
    changeKind: "feature",
    goal: "Change behavior",
    acceptanceCriteria: [
      {
        id: "AC1",
        statement: "Behavior changes",
        evidenceBasis: [
          { source: "task", detail: "The requested behavior is explicit.", references: [] },
        ],
      },
    ],
    protectedInvariants: [
      {
        id: "INV1",
        statement: "API is stable",
        evidenceBasis: [
          {
            source: "preservation",
            detail: "The existing export is a public boundary.",
            references: [{ path: "src/value.ts", detail: "Existing exported signature." }],
          },
        ],
      },
    ],
    nonGoals: [],
    allowedPathPrefixes: ["src", "test"],
    approvalRequiredChanges: [],
    evidenceGaps: [],
    risks: [
      {
        id: "R1",
        statement: "Local behavior may regress.",
        critical: true,
        resolutionStatus: "unresolved",
        resolution: "",
        relatedIds: ["AC1", "INV1"],
        evidenceBasis: [
          {
            source: "repository",
            detail: "The implementation serves both required and preserved behavior.",
            references: [{ path: "src/value.ts", detail: "Shared implementation boundary." }],
          },
        ],
      },
    ],
    unknowns: [],
    ...overrides,
  };
}

export function validPlan(overrides: Partial<DetailedPlan> = {}): DetailedPlan {
  return {
    planId: "plan-1",
    lens: "minimal-change",
    title: "Small fixture plan",
    approach: "Change one existing module",
    rationale: "The change is direct and bounded.",
    acceptanceCoverage: [{ id: "AC1", strategy: "Add an acceptance test." }],
    invariantProtection: [{ id: "INV1", strategy: "Keep the exported signature." }],
    riskMitigation: [{ id: "R1", strategy: "Exercise the old and requested behavior." }],
    files: [
      { path: "test/value.characterization.test.ts", purpose: "Preservation coverage" },
      { path: "test/value.test.ts", purpose: "Acceptance coverage" },
      { path: "src/value.ts", purpose: "Implementation" },
    ],
    steps: [
      {
        id: "S1",
        description: "Add baseline-green characterization coverage.",
        paths: ["test/value.characterization.test.ts"],
      },
      {
        id: "S2",
        description: "Add the failing acceptance test.",
        paths: ["test/value.test.ts"],
      },
      { id: "S3", description: "Implement the behavior.", paths: ["src/value.ts"] },
    ],
    safetyTests: [{ name: "acceptance", proves: "AC1", argv: ["npm", "test"], cwd: "." }],
    verificationCommands: [
      { name: "test", argv: ["npm", "test"], cwd: ".", purpose: "Verify behavior" },
    ],
    dependencies: [],
    migrations: [],
    approvalRequiredChanges: [],
    risks: [
      {
        id: "PR1",
        statement: "The local implementation may affect both behaviors.",
        critical: false,
        resolutionStatus: "unresolved",
        resolution: "",
        relatedIds: ["AC1", "INV1"],
        evidenceBasis: [
          {
            source: "repository",
            detail: "Both behaviors share the implementation boundary.",
            references: [{ path: "src/value.ts", detail: "Planned production edit." }],
          },
        ],
      },
    ],
    assumptions: [],
    unknowns: [],
    recovery: ["Revert the implementation commit."],
    rejectionReasons: [],
    ...overrides,
  };
}
