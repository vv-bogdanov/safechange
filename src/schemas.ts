import Type from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { ARTIFACT_KEY_PATTERN } from "./artifact-key.js";
import { ChangeSafelyError } from "./errors.js";

export const RUN_STATE_VERSION = 1;
export const LEGACY_ARTIFACT_VERSION = 2;
export const ARTIFACT_VERSION = 3;

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

function strictObject<const Properties extends Type.TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}

function stringEnum<const Values extends string[]>(...values: Values) {
  return Type.Unsafe<Values[number]>(Type.String({ enum: values }));
}

const HIGH_RISK_ITEM_LIMIT = 32;
const HIGH_RISK_PATH_LIMIT = 64;
const stringSchema = Type.String({ minLength: 1, maxLength: 400 });
const narrativeSchema = Type.String({ minLength: 1, maxLength: 2_000 });
const optionalNarrativeSchema = Type.String({ maxLength: 2_000 });
const identifierSchema = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]{0,99}$" });
const stringArraySchema = Type.Array(stringSchema, { maxItems: HIGH_RISK_ITEM_LIMIT });
const referenceSchema = strictObject({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  detail: narrativeSchema,
});
const commandSchema = strictObject({
  name: stringSchema,
  argv: Type.Array(stringSchema, { minItems: 1 }),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  purpose: stringSchema,
});
const taskEvidenceBasisSchema = strictObject({
  source: Type.Literal("task"),
  detail: narrativeSchema,
  references: Type.Array(referenceSchema, { maxItems: 0 }),
});
const repositoryEvidenceBasisSchema = strictObject({
  source: stringEnum("repository", "preservation"),
  detail: narrativeSchema,
  references: Type.Array(referenceSchema, { minItems: 1, maxItems: 8 }),
});
const evidenceBasisSchema = Type.Union([taskEvidenceBasisSchema, repositoryEvidenceBasisSchema]);
const evidenceBasisListSchema = Type.Array(evidenceBasisSchema, { minItems: 1, maxItems: 8 });
const relatedIdsSchema = Type.Array(identifierSchema, {
  minItems: 1,
  maxItems: HIGH_RISK_ITEM_LIMIT,
});
const contractItemSchema = strictObject({
  id: identifierSchema,
  statement: narrativeSchema,
  evidenceBasis: evidenceBasisListSchema,
});
const coverageSchema = strictObject({ id: stringSchema, strategy: stringSchema });
const nonGoalSchema = strictObject({
  id: identifierSchema,
  statement: narrativeSchema,
  evidenceBasis: Type.Array(
    Type.Union([
      taskEvidenceBasisSchema,
      strictObject({
        source: Type.Literal("repository"),
        detail: narrativeSchema,
        references: Type.Array(referenceSchema, { minItems: 1, maxItems: 8 }),
      }),
    ]),
    { minItems: 1, maxItems: 8 },
  ),
  relatedRiskIds: Type.Array(identifierSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
});
const riskSchema = strictObject({
  id: identifierSchema,
  statement: narrativeSchema,
  critical: Type.Boolean(),
  resolutionStatus: stringEnum("unresolved", "mitigated"),
  resolution: optionalNarrativeSchema,
  relatedIds: relatedIdsSchema,
  evidenceBasis: evidenceBasisListSchema,
});
const unknownSchema = strictObject({
  id: identifierSchema,
  statement: narrativeSchema,
  critical: Type.Boolean(),
  resolutionStatus: stringEnum("unresolved", "resolved"),
  resolution: optionalNarrativeSchema,
  relatedIds: relatedIdsSchema,
  evidenceBasis: evidenceBasisListSchema,
});

export const smokeArtifactSchema = strictObject({
  kind: Type.Literal("smoke"),
  message: stringSchema,
});

export const evidenceArtifactSchema = strictObject({
  summary: stringSchema,
  facts: Type.Array(
    strictObject({
      id: stringSchema,
      claim: stringSchema,
      references: Type.Array(referenceSchema, { maxItems: 4 }),
    }),
    { maxItems: 12 },
  ),
  commands: Type.Array(commandSchema, { maxItems: 6 }),
  testGaps: stringArraySchema,
  constraints: stringArraySchema,
  assumptions: stringArraySchema,
  unknowns: stringArraySchema,
});

export const changeContractSchema = strictObject({
  changeKind: stringEnum("refactor", "bugfix", "feature", "operational", "mixed"),
  goal: narrativeSchema,
  acceptanceCriteria: Type.Array(contractItemSchema, {
    minItems: 1,
    maxItems: HIGH_RISK_ITEM_LIMIT,
  }),
  protectedInvariants: Type.Array(contractItemSchema, {
    minItems: 1,
    maxItems: HIGH_RISK_ITEM_LIMIT,
  }),
  nonGoals: Type.Array(nonGoalSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  allowedPathPrefixes: Type.Array(stringSchema, {
    minItems: 1,
    maxItems: HIGH_RISK_PATH_LIMIT,
  }),
  approvalRequiredChanges: stringArraySchema,
  evidenceGaps: stringArraySchema,
  risks: Type.Array(riskSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  unknowns: Type.Array(unknownSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
});

const plannedFileSchema = strictObject({ path: stringSchema, purpose: stringSchema });
const planStepSchema = strictObject({
  id: stringSchema,
  description: stringSchema,
  paths: stringArraySchema,
});
const safetyTestSchema = strictObject({
  name: stringSchema,
  proves: stringSchema,
  argv: Type.Array(stringSchema, { minItems: 1 }),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const detailedPlanSchema = strictObject({
  planId: stringSchema,
  lens: stringSchema,
  title: stringSchema,
  approach: stringSchema,
  rationale: stringSchema,
  acceptanceCoverage: Type.Array(coverageSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  invariantProtection: Type.Array(coverageSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  riskMitigation: Type.Array(coverageSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  files: Type.Array(plannedFileSchema, { minItems: 1, maxItems: HIGH_RISK_PATH_LIMIT }),
  steps: Type.Array(planStepSchema, { minItems: 1, maxItems: HIGH_RISK_ITEM_LIMIT }),
  safetyTests: Type.Array(safetyTestSchema, { minItems: 1, maxItems: HIGH_RISK_ITEM_LIMIT }),
  verificationCommands: Type.Array(commandSchema, { minItems: 1, maxItems: 12 }),
  dependencies: stringArraySchema,
  migrations: stringArraySchema,
  approvalRequiredChanges: stringArraySchema,
  risks: Type.Array(riskSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  assumptions: stringArraySchema,
  unknowns: Type.Array(unknownSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  recovery: Type.Array(stringSchema, { minItems: 1, maxItems: 6 }),
  rejectionReasons: stringArraySchema,
});

const legacyContractItemSchema = strictObject({ id: stringSchema, statement: stringSchema });
const legacyChangeContractSchema = strictObject({
  goal: stringSchema,
  acceptanceCriteria: Type.Array(legacyContractItemSchema, { minItems: 1, maxItems: 12 }),
  protectedInvariants: Type.Array(legacyContractItemSchema, { minItems: 1, maxItems: 12 }),
  nonGoals: Type.Array(stringSchema, { maxItems: 12 }),
  allowedPathPrefixes: Type.Array(stringSchema, { minItems: 1, maxItems: 12 }),
  approvalRequiredChanges: Type.Array(stringSchema, { maxItems: 12 }),
  evidenceGaps: Type.Array(stringSchema, { maxItems: 12 }),
  risks: Type.Array(stringSchema, { maxItems: 12 }),
  unknowns: Type.Array(stringSchema, { maxItems: 12 }),
});
const legacyPlanUnknownSchema = strictObject({
  description: stringSchema,
  critical: Type.Boolean(),
  resolution: Type.String({ maxLength: 400 }),
});
const legacyDetailedPlanSchema = strictObject({
  planId: stringSchema,
  lens: stringSchema,
  title: stringSchema,
  approach: stringSchema,
  rationale: stringSchema,
  acceptanceCoverage: Type.Array(coverageSchema, { maxItems: 12 }),
  invariantProtection: Type.Array(coverageSchema, { maxItems: 12 }),
  files: Type.Array(plannedFileSchema, { minItems: 1, maxItems: 12 }),
  steps: Type.Array(planStepSchema, { minItems: 1, maxItems: 12 }),
  safetyTests: Type.Array(safetyTestSchema, { minItems: 1, maxItems: 12 }),
  verificationCommands: Type.Array(commandSchema, { minItems: 1, maxItems: 6 }),
  dependencies: Type.Array(stringSchema, { maxItems: 12 }),
  migrations: Type.Array(stringSchema, { maxItems: 12 }),
  approvalRequiredChanges: Type.Array(stringSchema, { maxItems: 12 }),
  risks: Type.Array(stringSchema, { maxItems: 12 }),
  assumptions: Type.Array(stringSchema, { maxItems: 12 }),
  unknowns: Type.Array(legacyPlanUnknownSchema, { maxItems: 8 }),
  recovery: Type.Array(stringSchema, { minItems: 1, maxItems: 6 }),
  rejectionReasons: Type.Array(stringSchema, { maxItems: 12 }),
});

const rejectedPlanSchema = strictObject({ planId: stringSchema, reason: stringSchema });

export const decisionArtifactSchema = strictObject({
  winnerPlanId: stringSchema,
  reason: stringSchema,
  rejectedPlans: Type.Array(rejectedPlanSchema, { maxItems: 5 }),
  tradeoffs: stringArraySchema,
  residualRisks: stringArraySchema,
  humanDecisionRequired: Type.Boolean(),
  humanDecisionReason: Type.String({ maxLength: 400 }),
});

export const harnessArtifactSchema = strictObject({
  summary: stringSchema,
  testPaths: Type.Array(stringSchema, { minItems: 1, maxItems: 12 }),
  fixturePaths: stringArraySchema,
  targetedCommand: commandSchema,
  expectedBaselineOutcome: stringEnum("fail", "pass"),
  expectedFailure: Type.String({ minLength: 1, maxLength: 400 }),
  protectedPaths: Type.Array(stringSchema, { minItems: 1, maxItems: 12 }),
});

export const implementationArtifactSchema = strictObject({
  summary: stringSchema,
  changedPaths: Type.Array(stringSchema, { maxItems: 12 }),
  testsAdded: stringArraySchema,
  scopeNotes: stringArraySchema,
  residualRisks: stringArraySchema,
});

const verificationFindingSchema = strictObject({
  code: stringSchema,
  severity: stringEnum("error", "warning"),
  message: stringSchema,
  path: Type.String({ maxLength: 400 }),
});

export const verificationArtifactSchema = strictObject({
  verdict: stringEnum("accept", "reject"),
  contractFulfilled: Type.Boolean(),
  invariantsPreserved: Type.Boolean(),
  scopeConformant: Type.Boolean(),
  evidenceSufficient: Type.Boolean(),
  reason: stringSchema,
  findings: Type.Array(verificationFindingSchema, { maxItems: 12 }),
  residualRisks: stringArraySchema,
});

const sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const runIdSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
  not: { enum: [".", ".."] },
});
const nullableStringSchema = Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]);
const hashRecordSchema = Type.Record(Type.String(), sha256Schema, {
  maxProperties: 16,
  propertyNames: Type.String({ minLength: 1, maxLength: 255 }),
});
const artifactHashRecordSchema = Type.Record(Type.String(), sha256Schema, {
  maxProperties: 32,
  propertyNames: Type.String({
    pattern: ARTIFACT_KEY_PATTERN,
  }),
});
const contextEntrySchema = strictObject({
  role: Type.String({ minLength: 1, maxLength: 100 }),
  threadId: Type.String({ minLength: 1, maxLength: 4096 }),
  parentThreadId: nullableStringSchema,
  checkpointTurnId: nullableStringSchema,
  turnId: nullableStringSchema,
  status: stringEnum("started", "completed", "failed"),
});

const repositoryCheckSchema = strictObject({
  id: Type.String({ minLength: 1, maxLength: 255 }),
  kind: stringEnum("test", "typecheck", "lint", "build"),
  argv: Type.Array(stringSchema, { minItems: 1, maxItems: 64 }),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
});

const repositoryCapabilitiesSchema = strictObject({
  checks: Type.Array(repositoryCheckSchema, { minItems: 1, maxItems: 64 }),
  testPathPrefixes: Type.Array(stringSchema, { minItems: 1, maxItems: 64 }),
  testFilePatterns: Type.Array(stringSchema, { maxItems: 32 }),
  controlFiles: Type.Array(stringSchema, { maxItems: 128 }),
  sources: Type.Array(stringSchema, { minItems: 1, maxItems: 32 }),
});

const runPhaseSchema = stringEnum(
  "preflight",
  "discovery",
  "contract",
  "planners",
  "eligibility",
  "judge",
  "planning-complete",
  "failed",
  "baseline-changed",
  "write-preflight-blocked",
  "test-author",
  "harness-complete",
  "test-author-failed",
  "implementer",
  "deterministic-verification",
  "verifier",
  "repair",
  "verifier:repair",
  "verification-complete",
  "implementation-failed",
  "verified",
  "release-gate-blocked",
);

const runStatusSchema = stringEnum(
  "RUNNING",
  "PLANNED",
  "BLOCKED",
  "HUMAN_DECISION_REQUIRED",
  "BASELINE_CHANGED",
  "REPLAN_REQUIRED",
  "FAILED",
  "VERIFIED",
);

const runStateSchema = strictObject({
  stateVersion: Type.Literal(RUN_STATE_VERSION),
  producerVersion: Type.String({ minLength: 1, maxLength: 255 }),
  runId: runIdSchema,
  task: Type.String({ minLength: 1, maxLength: 100_000 }),
  repoPath: Type.String({ minLength: 1, maxLength: 4096 }),
  baselineCommit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
  baselineFingerprint: sha256Schema,
  baselineProtectedConfiguration: hashRecordSchema,
  repositoryCapabilities: Type.Optional(repositoryCapabilitiesSchema),
  repositoryCapabilitiesSha256: Type.Optional(sha256Schema),
  phase: runPhaseSchema,
  status: runStatusSchema,
  reason: Type.String({ maxLength: 32_768 }),
  nextAction: Type.String({ maxLength: 4096 }),
  artifacts: artifactHashRecordSchema,
  contexts: Type.Array(contextEntrySchema, { maxItems: 64 }),
  branch: Type.String({ maxLength: 1024 }),
  testCommit: Type.String({ pattern: "^(?:[a-f0-9]{40,64})?$" }),
  implementationCommit: Type.String({ pattern: "^(?:[a-f0-9]{40,64})?$" }),
  repairCount: Type.Integer({ minimum: 0, maximum: 1 }),
  model: Type.String({ maxLength: 255 }),
  permissionProfile: Type.Optional(Type.String({ maxLength: 100 })),
});

const artifactEnvelopeSchema = strictObject({
  meta: strictObject({
    artifactVersion: Type.Union([
      Type.Literal(LEGACY_ARTIFACT_VERSION),
      Type.Literal(ARTIFACT_VERSION),
    ]),
    producerVersion: Type.String({ minLength: 1, maxLength: 255 }),
    runId: runIdSchema,
    baselineCommit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
    role: Type.String({ minLength: 1, maxLength: 100 }),
    createdAt: Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
    }),
    inputs: artifactHashRecordSchema,
  }),
  payload: Type.Unknown(),
});

const eligibilityFailureSchema = strictObject({ code: stringSchema, message: stringSchema });
const planEligibilitySchema = strictObject({
  planId: stringSchema,
  eligible: Type.Boolean(),
  failures: Type.Array(eligibilityFailureSchema, { maxItems: HIGH_RISK_ITEM_LIMIT }),
  humanDecisionReasons: stringArraySchema,
});

const planEligibilityListSchema = Type.Array(planEligibilitySchema, {
  minItems: 1,
  maxItems: 5,
});

const commandEvidenceSchema = strictObject({
  commandId: Type.String({ minLength: 1, maxLength: 100 }),
  command: Type.String({ minLength: 1, maxLength: 255 }),
  argv: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
    minItems: 1,
    maxItems: 64,
  }),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  startedAt: Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
  }),
  completedAt: Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
  }),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  timedOut: Type.Boolean(),
  sandboxed: Type.Boolean(),
  durationMs: Type.Integer({ minimum: 0 }),
  stdoutBytes: Type.Integer({ minimum: 0 }),
  stderrBytes: Type.Integer({ minimum: 0 }),
  stdoutSha256: sha256Schema,
  stderrSha256: sha256Schema,
  stdoutTruncated: Type.Boolean(),
  stderrTruncated: Type.Boolean(),
});

const commandEvidenceListSchema = Type.Array(commandEvidenceSchema, {
  minItems: 1,
  maxItems: HIGH_RISK_ITEM_LIMIT,
});

const protectedHashesSchema = Type.Record(Type.String(), sha256Schema, {
  minProperties: 1,
  maxProperties: HIGH_RISK_PATH_LIMIT,
  propertyNames: Type.String({ minLength: 1, maxLength: 4096 }),
});

const storedHarnessArtifactSchema = strictObject({
  ...harnessArtifactSchema.properties,
  protectedHashes: protectedHashesSchema,
  testCommit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
});

const storedImplementationArtifactSchema = strictObject({
  ...implementationArtifactSchema.properties,
  implementationCommit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
  actualPaths: Type.Array(stringSchema, { minItems: 1, maxItems: 32 }),
});

export type EvidenceArtifact = Mutable<Type.Static<typeof evidenceArtifactSchema>>;
export type ChangeContract = Mutable<Type.Static<typeof changeContractSchema>>;
export type DetailedPlan = Mutable<Type.Static<typeof detailedPlanSchema>>;
export type DecisionArtifact = Mutable<Type.Static<typeof decisionArtifactSchema>>;
export type HarnessArtifact = Mutable<Type.Static<typeof harnessArtifactSchema>>;
export type VerificationArtifact = Mutable<Type.Static<typeof verificationArtifactSchema>>;
export type ContextEntry = Mutable<Type.Static<typeof contextEntrySchema>>;
export type RunState = Mutable<Type.Static<typeof runStateSchema>>;
export type RunPhase = RunState["phase"];
export type RunStatus = RunState["status"];
export type PlanEligibility = Mutable<Type.Static<typeof planEligibilitySchema>>;
export type CommandEvidence = Mutable<Type.Static<typeof commandEvidenceSchema>>;
export type StoredHarnessArtifact = Mutable<Type.Static<typeof storedHarnessArtifactSchema>>;

export class ArtifactValidationError extends ChangeSafelyError {
  constructor(
    public readonly artifactName: string,
    public readonly validationErrors: TLocalizedValidationError[],
  ) {
    const message = `Invalid ${artifactName}: ${validationErrors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ")}`;
    super("ARTIFACT_VALIDATION_FAILED", message, {
      nextAction: "Inspect the invalid artifact and start a new run after fixing its producer.",
    });
    this.name = "ArtifactValidationError";
  }
}

function compileArtifactValidator<const Schema extends Type.TSchema>(
  artifactName: string,
  schema: Schema,
): (value: unknown) => Mutable<Type.Static<Schema>> {
  const validator = Compile(schema);
  return (value: unknown): Mutable<Type.Static<Schema>> => {
    if (!validator.Check(value)) {
      throw new ArtifactValidationError(artifactName, validator.Errors(value));
    }
    return value as Mutable<Type.Static<Schema>>;
  };
}

const RESUMABLE_STATUS_BY_PHASE = {
  "planning-complete": "PLANNED",
  "harness-complete": "RUNNING",
  "verification-complete": "RUNNING",
  verified: "VERIFIED",
} as const satisfies Partial<Record<RunPhase, RunStatus>>;

const RUN_STATE_STATUSES_BY_PHASE = {
  preflight: ["RUNNING"],
  discovery: ["RUNNING"],
  contract: ["RUNNING"],
  planners: ["RUNNING"],
  eligibility: ["RUNNING"],
  judge: ["RUNNING"],
  "planning-complete": ["PLANNED", "BLOCKED", "HUMAN_DECISION_REQUIRED"],
  failed: ["FAILED"],
  "baseline-changed": ["BASELINE_CHANGED"],
  "write-preflight-blocked": ["BLOCKED"],
  "test-author": ["RUNNING"],
  "harness-complete": ["RUNNING"],
  "test-author-failed": ["FAILED", "BLOCKED"],
  implementer: ["RUNNING"],
  "deterministic-verification": ["RUNNING"],
  verifier: ["RUNNING"],
  repair: ["RUNNING"],
  "verifier:repair": ["RUNNING"],
  "verification-complete": ["RUNNING", "FAILED"],
  "implementation-failed": ["FAILED", "BLOCKED", "REPLAN_REQUIRED", "HUMAN_DECISION_REQUIRED"],
  verified: ["VERIFIED"],
  "release-gate-blocked": ["BLOCKED"],
} as const satisfies Record<RunPhase, readonly RunStatus[]>;

export class RunStateInvariantError extends ChangeSafelyError {
  constructor(state: Pick<RunState, "phase" | "status">) {
    super(
      "RUN_STATE_INVARIANT_FAILED",
      `Invalid ChangeSafely phase/status combination: ${state.phase}/${state.status}`,
      {
        exitCode: 2,
        nextAction: "Inspect the persisted run state and start a new run if it is stale.",
      },
    );
    this.name = "RunStateInvariantError";
  }
}

export function resumablePhase(
  state: Pick<RunState, "phase" | "status">,
): keyof typeof RESUMABLE_STATUS_BY_PHASE | undefined {
  const phase = state.phase as keyof typeof RESUMABLE_STATUS_BY_PHASE;
  return RESUMABLE_STATUS_BY_PHASE[phase] === state.status ? phase : undefined;
}

export const validateSmokeArtifact = compileArtifactValidator(
  "smoke artifact",
  smokeArtifactSchema,
);
export const validateEvidenceArtifact = compileArtifactValidator(
  "evidence artifact",
  evidenceArtifactSchema,
);
export const validateChangeContract = compileArtifactValidator(
  "change contract",
  changeContractSchema,
);
export const validateDetailedPlan = compileArtifactValidator("detailed plan", detailedPlanSchema);
const validateLegacyChangeContract = compileArtifactValidator(
  "legacy change contract",
  legacyChangeContractSchema,
);
const validateLegacyDetailedPlan = compileArtifactValidator(
  "legacy detailed plan",
  legacyDetailedPlanSchema,
);

function migratedEvidenceBasis() {
  return [
    {
      source: "task" as const,
      detail: "Migrated from an artifact v2 assertion whose finer provenance was not recorded.",
      references: [],
    },
  ];
}

export function validatePersistedChangeContract(value: unknown, artifactVersion: number) {
  if (artifactVersion === ARTIFACT_VERSION) return validateChangeContract(value);
  const legacy = validateLegacyChangeContract(value);
  const relatedId = legacy.acceptanceCriteria[0]?.id ?? legacy.protectedInvariants[0]?.id ?? "AC1";
  return validateChangeContract({
    changeKind: "mixed",
    goal: legacy.goal,
    acceptanceCriteria: legacy.acceptanceCriteria.map((item) => ({
      ...item,
      evidenceBasis: migratedEvidenceBasis(),
    })),
    protectedInvariants: legacy.protectedInvariants.map((item) => ({
      ...item,
      evidenceBasis: migratedEvidenceBasis(),
    })),
    nonGoals: legacy.nonGoals.map((statement, index) => ({
      id: `NG${index + 1}`,
      statement,
      evidenceBasis: migratedEvidenceBasis(),
      relatedRiskIds: [],
    })),
    allowedPathPrefixes: legacy.allowedPathPrefixes,
    approvalRequiredChanges: legacy.approvalRequiredChanges,
    evidenceGaps: legacy.evidenceGaps,
    risks: legacy.risks.map((statement, index) => ({
      id: `R${index + 1}`,
      statement,
      critical: true,
      resolutionStatus: "unresolved",
      resolution: "",
      relatedIds: [relatedId],
      evidenceBasis: migratedEvidenceBasis(),
    })),
    unknowns: legacy.unknowns.map((statement, index) => ({
      id: `U${index + 1}`,
      statement,
      critical: true,
      resolutionStatus: "unresolved",
      resolution: "",
      relatedIds: [relatedId],
      evidenceBasis: migratedEvidenceBasis(),
    })),
  });
}

export function validatePersistedDetailedPlan(value: unknown, artifactVersion: number) {
  if (artifactVersion === ARTIFACT_VERSION) return validateDetailedPlan(value);
  const legacy = validateLegacyDetailedPlan(value);
  const relatedId =
    legacy.acceptanceCoverage[0]?.id ?? legacy.invariantProtection[0]?.id ?? legacy.planId;
  return validateDetailedPlan({
    ...legacy,
    riskMitigation: [],
    risks: legacy.risks.map((statement, index) => ({
      id: `PR${index + 1}`,
      statement,
      critical: true,
      resolutionStatus: "unresolved",
      resolution: "",
      relatedIds: [relatedId],
      evidenceBasis: migratedEvidenceBasis(),
    })),
    unknowns: legacy.unknowns.map((unknown, index) => ({
      id: `PU${index + 1}`,
      statement: unknown.description,
      critical: unknown.critical,
      resolutionStatus: unknown.resolution.trim() === "" ? "unresolved" : "resolved",
      resolution: unknown.resolution,
      relatedIds: [relatedId],
      evidenceBasis: migratedEvidenceBasis(),
    })),
  });
}
export const validateDecisionArtifact = compileArtifactValidator(
  "decision artifact",
  decisionArtifactSchema,
);
export const validateHarnessArtifact = compileArtifactValidator(
  "harness artifact",
  harnessArtifactSchema,
);
export const validateImplementationArtifact = compileArtifactValidator(
  "implementation artifact",
  implementationArtifactSchema,
);
export const validateVerificationArtifact = compileArtifactValidator(
  "verification artifact",
  verificationArtifactSchema,
);
const validateRunStateSchema = compileArtifactValidator("ChangeSafely run state", runStateSchema);
export function validateRunState(value: unknown): RunState {
  const state = validateRunStateSchema(value);
  if (!(RUN_STATE_STATUSES_BY_PHASE[state.phase] as readonly RunStatus[]).includes(state.status)) {
    throw new RunStateInvariantError(state);
  }
  return state;
}
export const validateArtifactEnvelope = compileArtifactValidator(
  "ChangeSafely artifact envelope",
  artifactEnvelopeSchema,
);
export const validatePlanEligibilityList = compileArtifactValidator(
  "plan eligibility artifact",
  planEligibilityListSchema,
);
export const validateCommandEvidenceList = compileArtifactValidator(
  "command evidence artifact",
  commandEvidenceListSchema,
);
export const validateStoredHarnessArtifact = compileArtifactValidator(
  "stored harness artifact",
  storedHarnessArtifactSchema,
);
export const validateStoredImplementationArtifact = compileArtifactValidator(
  "stored implementation artifact",
  storedImplementationArtifactSchema,
);
