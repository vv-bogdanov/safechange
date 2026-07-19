import Type from "typebox";
import { Compile } from "typebox/compile";

export const EVIDENCE_VERSION = 1;
export const COMPARISON_VERSION = 1;
export const ANALYSIS_VERSION = 1;

export type BenchmarkMode = "changesafely" | "direct";
export type BenchmarkMeasurement = "development" | "final";
export type BenchmarkOutcome =
  | "safe_success"
  | "unsafe_green"
  | "visible_failure"
  | "scope_failure"
  | "technical_failure";

interface WorkerResult {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface RunDocument {
  evidenceVersion: typeof EVIDENCE_VERSION;
  runId: string;
  comparisonId: string;
  comparisonSha256: string;
  scenario: string;
  scenarioVersion?: number;
  mode: BenchmarkMode;
  measurement?: BenchmarkMeasurement;
  taskText: string;
  taskSha256: string;
  baselineCommit: string;
  snapshotCommit: string;
  model: string;
  effort: string;
  environment: {
    nodeVersion: string;
    gitVersion: string;
    codexVersion: string;
    changesafelyVersion: string;
    changesafelyCommit?: string;
    platform: string;
    architecture: string;
  };
  isolation: {
    provider: "codex-permission-profile";
    permissionProfile: string;
    canarySha256: string;
    agentToolNetwork: "disabled";
  };
  worker: WorkerResult;
  usage: {
    turns: number | null;
    totalTokens?: number | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    nonCachedInputTokens?: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
  };
  outcome: BenchmarkOutcome;
}

export interface ComparisonManifest {
  comparisonVersion: typeof COMPARISON_VERSION;
  comparisonId: string;
  createdAt: string;
  measurement?: BenchmarkMeasurement;
  scenario: string;
  scenarioVersion?: number;
  taskText: string;
  taskSha256: string;
  baselineCommit: string;
  model: string;
  effort: string;
  timeoutMs: number;
  permissionProfile: string;
  agentToolNetwork: "disabled";
  visibleChecks: ["npm test"];
  evaluatorSha256: string;
  executionOrder: ["direct", "changesafely"];
  maxAttemptsPerMode: 1;
  environment: {
    nodeVersion: string;
    gitVersion: string;
    codexVersion: string;
    changesafelyVersion: string;
    changesafelyCommit?: string;
    platform: string;
    architecture: string;
  };
}

export interface EvaluationDocument {
  schemaVersion: 1;
  scenario: string;
  checks: Array<{
    id: string;
    category: "acceptance" | "preservation" | "scope" | "visible";
    passed: boolean;
    detail: string;
  }>;
  summary: {
    visible: boolean;
    acceptance: boolean;
    preservation: boolean;
    scope: boolean;
  };
  passed: boolean;
}

interface EvidenceFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EvidenceManifest {
  evidenceVersion: typeof EVIDENCE_VERSION;
  runId: string;
  files: EvidenceFile[];
}

interface AnalysisProcess {
  started: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface AnalysisDocument {
  analysisVersion: typeof ANALYSIS_VERSION;
  runId: string;
  evidenceManifestSha256: string;
  scenario: string;
  candidateTests: {
    paths: string[];
    patchSha256: string;
    additions: number;
    deletions: number;
  };
  reference: {
    passed: boolean;
    process: AnalysisProcess;
  };
  mutants: Array<{
    id: string;
    killed: boolean;
    process: AnalysisProcess;
  }>;
  mutation: {
    killed: number;
    total: number;
    killRate: number | null;
  };
  protectedTests: {
    applicable: boolean;
    intact: boolean | null;
    paths: string[];
    detail: string;
  };
}

export interface AnalysisManifest {
  analysisVersion: typeof ANALYSIS_VERSION;
  runId: string;
  evidenceManifestSha256: string;
  analysisSha256: string;
}

const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const commit = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const nullableCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const runId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });

const workerResultSchema = Type.Object(
  {
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: Type.Integer({ minimum: 0 }),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    timedOut: Type.Boolean(),
  },
  { additionalProperties: false },
);

const environmentSchema = Type.Object(
  {
    nodeVersion: Type.String({ minLength: 1, maxLength: 100 }),
    gitVersion: Type.String({ minLength: 1, maxLength: 500 }),
    codexVersion: Type.String({ minLength: 1, maxLength: 500 }),
    changesafelyVersion: Type.String({ minLength: 1, maxLength: 100 }),
    changesafelyCommit: Type.Optional(commit),
    platform: Type.String({ minLength: 1, maxLength: 100 }),
    architecture: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

const runDocumentSchema = Type.Object(
  {
    evidenceVersion: Type.Literal(EVIDENCE_VERSION),
    runId,
    comparisonId: Type.String({ pattern: "^comparison-[a-f0-9]{16}$" }),
    comparisonSha256: sha256,
    scenario: Type.String({ minLength: 1, maxLength: 100 }),
    scenarioVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    mode: Type.Union([Type.Literal("changesafely"), Type.Literal("direct")]),
    measurement: Type.Optional(Type.Union([Type.Literal("development"), Type.Literal("final")])),
    taskText: Type.String({ minLength: 1, maxLength: 20_000 }),
    taskSha256: sha256,
    baselineCommit: commit,
    snapshotCommit: commit,
    model: Type.String({ minLength: 1, maxLength: 255 }),
    effort: Type.String({ minLength: 1, maxLength: 100 }),
    environment: environmentSchema,
    isolation: Type.Object(
      {
        provider: Type.Literal("codex-permission-profile"),
        permissionProfile: Type.String({ minLength: 1, maxLength: 100 }),
        canarySha256: sha256,
        agentToolNetwork: Type.Literal("disabled"),
      },
      { additionalProperties: false },
    ),
    worker: workerResultSchema,
    usage: Type.Object(
      {
        turns: nullableCount,
        totalTokens: Type.Optional(nullableCount),
        inputTokens: nullableCount,
        cachedInputTokens: nullableCount,
        nonCachedInputTokens: Type.Optional(nullableCount),
        outputTokens: nullableCount,
        reasoningTokens: nullableCount,
      },
      { additionalProperties: false },
    ),
    outcome: Type.Union([
      Type.Literal("safe_success"),
      Type.Literal("unsafe_green"),
      Type.Literal("visible_failure"),
      Type.Literal("scope_failure"),
      Type.Literal("technical_failure"),
    ]),
  },
  { additionalProperties: false },
);

const comparisonManifestSchema = Type.Object(
  {
    comparisonVersion: Type.Literal(COMPARISON_VERSION),
    comparisonId: Type.String({ pattern: "^comparison-[a-f0-9]{16}$" }),
    createdAt: timestamp,
    measurement: Type.Optional(Type.Union([Type.Literal("development"), Type.Literal("final")])),
    scenario: Type.String({ minLength: 1, maxLength: 100 }),
    scenarioVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    taskText: Type.String({ minLength: 1, maxLength: 20_000 }),
    taskSha256: sha256,
    baselineCommit: commit,
    model: Type.String({ minLength: 1, maxLength: 255 }),
    effort: Type.String({ minLength: 1, maxLength: 100 }),
    timeoutMs: Type.Integer({ minimum: 1 }),
    permissionProfile: Type.String({ minLength: 1, maxLength: 100 }),
    agentToolNetwork: Type.Literal("disabled"),
    visibleChecks: Type.Tuple([Type.Literal("npm test")]),
    evaluatorSha256: sha256,
    executionOrder: Type.Tuple([Type.Literal("direct"), Type.Literal("changesafely")]),
    maxAttemptsPerMode: Type.Literal(1),
    environment: environmentSchema,
  },
  { additionalProperties: false },
);

const evidenceManifestSchema = Type.Object(
  {
    evidenceVersion: Type.Literal(EVIDENCE_VERSION),
    runId,
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 500 }),
          bytes: Type.Integer({ minimum: 0 }),
          sha256,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

const evaluationDocumentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scenario: Type.String({ minLength: 1, maxLength: 100 }),
    checks: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 100 }),
          category: Type.Union([
            Type.Literal("acceptance"),
            Type.Literal("preservation"),
            Type.Literal("scope"),
            Type.Literal("visible"),
          ]),
          passed: Type.Boolean(),
          detail: Type.String({ maxLength: 10_000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    summary: Type.Object(
      {
        visible: Type.Boolean(),
        acceptance: Type.Boolean(),
        preservation: Type.Boolean(),
        scope: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    passed: Type.Boolean(),
  },
  { additionalProperties: false },
);

const analysisProcessSchema = Type.Object(
  {
    started: Type.Boolean(),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    timedOut: Type.Boolean(),
  },
  { additionalProperties: false },
);

const analysisDocumentSchema = Type.Object(
  {
    analysisVersion: Type.Literal(ANALYSIS_VERSION),
    runId,
    evidenceManifestSha256: sha256,
    scenario: Type.String({ minLength: 1, maxLength: 100 }),
    candidateTests: Type.Object(
      {
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          maxItems: 100,
        }),
        patchSha256: sha256,
        additions: Type.Integer({ minimum: 0 }),
        deletions: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    reference: Type.Object(
      { passed: Type.Boolean(), process: analysisProcessSchema },
      { additionalProperties: false },
    ),
    mutants: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,99}$" }),
          killed: Type.Boolean(),
          process: analysisProcessSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    mutation: Type.Object(
      {
        killed: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 1 }),
        killRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    protectedTests: Type.Object(
      {
        applicable: Type.Boolean(),
        intact: Type.Union([Type.Boolean(), Type.Null()]),
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          maxItems: 100,
        }),
        detail: Type.String({ minLength: 1, maxLength: 1_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const analysisManifestSchema = Type.Object(
  {
    analysisVersion: Type.Literal(ANALYSIS_VERSION),
    runId,
    evidenceManifestSha256: sha256,
    analysisSha256: sha256,
  },
  { additionalProperties: false },
);

const validateRunDocumentSchema = Compile(runDocumentSchema);
const validateEvidenceManifestSchema = Compile(evidenceManifestSchema);
const validateComparisonManifestSchema = Compile(comparisonManifestSchema);
const validateEvaluationDocumentSchema = Compile(evaluationDocumentSchema);
const validateAnalysisDocumentSchema = Compile(analysisDocumentSchema);
const validateAnalysisManifestSchema = Compile(analysisManifestSchema);

export function validateRunDocument(value: unknown): RunDocument {
  if (!validateRunDocumentSchema.Check(value)) throw new Error("Invalid benchmark run document");
  return value as RunDocument;
}

export function validateEvidenceManifest(value: unknown): EvidenceManifest {
  if (!validateEvidenceManifestSchema.Check(value)) {
    throw new Error("Invalid benchmark evidence manifest");
  }
  return value as EvidenceManifest;
}

export function validateComparisonManifest(value: unknown): ComparisonManifest {
  if (!validateComparisonManifestSchema.Check(value)) {
    throw new Error("Invalid benchmark comparison manifest");
  }
  return value as ComparisonManifest;
}

export function validateEvaluationDocument(value: unknown): EvaluationDocument {
  if (!validateEvaluationDocumentSchema.Check(value)) {
    throw new Error("Invalid benchmark evaluation document");
  }
  return value as EvaluationDocument;
}

export function validateAnalysisDocument(value: unknown): AnalysisDocument {
  if (!validateAnalysisDocumentSchema.Check(value)) {
    throw new Error("Invalid benchmark analysis document");
  }
  const analysis = value as AnalysisDocument;
  if (
    analysis.mutation.total !== analysis.mutants.length ||
    analysis.mutation.killed !== analysis.mutants.filter((mutant) => mutant.killed).length ||
    (analysis.reference.passed
      ? analysis.mutation.killRate !== analysis.mutation.killed / analysis.mutation.total
      : analysis.mutation.killRate !== null) ||
    (analysis.protectedTests.applicable
      ? analysis.protectedTests.intact === null || analysis.protectedTests.paths.length === 0
      : analysis.protectedTests.intact !== null || analysis.protectedTests.paths.length !== 0)
  ) {
    throw new Error("Invalid benchmark analysis invariants");
  }
  return analysis;
}

export function validateAnalysisManifest(value: unknown): AnalysisManifest {
  if (!validateAnalysisManifestSchema.Check(value)) {
    throw new Error("Invalid benchmark analysis manifest");
  }
  return value as AnalysisManifest;
}
