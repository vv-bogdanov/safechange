import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  type ArtifactInputHashes,
  type ArtifactPayload,
  artifactDefinition,
  validateArtifactInputKeys,
} from "./artifact-catalog.js";
import { type ArtifactKey, isArtifactKey, parsePlanArtifactKey } from "./artifact-key.js";
import { ChangeSafelyError } from "./errors.js";
import {
  ARTIFACT_VERSION,
  LEGACY_ARTIFACT_VERSION,
  RUN_STATE_VERSION,
  type RunState,
  validateArtifactEnvelope,
  validateRunState,
} from "./schemas.js";
import { TraceWriter } from "./trace.js";
import { VERSION } from "./version.js";

export type { RunState } from "./schemas.js";

export interface ArtifactEnvelope<T> {
  meta: {
    artifactVersion: typeof ARTIFACT_VERSION | typeof LEGACY_ARTIFACT_VERSION;
    producerVersion: string;
    runId: string;
    baselineCommit: string;
    role: string;
    createdAt: string;
    inputs: ArtifactInputHashes;
  };
  payload: T;
}

export type PersistedVersionErrorCode =
  | "UNSUPPORTED_STATE_VERSION"
  | "UNSUPPORTED_ARTIFACT_VERSION";

export class PersistedVersionError extends ChangeSafelyError {
  constructor(
    public readonly code: PersistedVersionErrorCode,
    actual: unknown,
    expected: number,
  ) {
    super(code, `${code}: expected ${expected}, received ${String(actual)}`, {
      exitCode: 2,
      nextAction: "Start a new ChangeSafely run with the installed CLI version.",
    });
    this.name = "PersistedVersionError";
  }
}

export interface StoredArtifact<T> {
  path: string;
  hash: string;
  envelope: ArtifactEnvelope<T>;
}

export function createRunId(): string {
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  return `${time}-${randomUUID().slice(0, 8)}`;
}

export function validateRunId(runId: string): string {
  if (runId === "." || runId === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`Invalid ChangeSafely run id: ${runId}`);
  }
  return runId;
}

function resolveWithin(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes the ChangeSafely run directory: ${relativePath}`);
  }
  return path;
}

function runPath(repoPath: string, runId: string): string {
  return resolve(repoPath, ".changesafely", "runs", validateRunId(runId));
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseJson(content: string, description: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new ChangeSafelyError("INVALID_PERSISTED_JSON", `Invalid JSON in ${description}`, {
      exitCode: 2,
      nextAction: "Inspect the damaged run data and start a new ChangeSafely run.",
    });
  }
}

function property(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function assertStateVersion(value: unknown): void {
  const actual = property(value, "stateVersion");
  if (actual !== RUN_STATE_VERSION) {
    throw new PersistedVersionError("UNSUPPORTED_STATE_VERSION", actual, RUN_STATE_VERSION);
  }
}

function assertArtifactVersion(value: unknown): void {
  const actual = property(property(value, "meta"), "artifactVersion");
  if (actual !== ARTIFACT_VERSION && actual !== LEGACY_ARTIFACT_VERSION) {
    throw new PersistedVersionError("UNSUPPORTED_ARTIFACT_VERSION", actual, ARTIFACT_VERSION);
  }
}

export function artifactInputs(state: RunState, ...keys: ArtifactKey[]): ArtifactInputHashes {
  const inputs: ArtifactInputHashes = {};
  for (const key of keys) {
    const hash = state.artifacts[key];
    if (!hash) throw new Error(`Missing persisted artifact input: ${key}`);
    inputs[key] = hash;
  }
  return inputs;
}

export class ArtifactStore {
  readonly runPath: string;
  public readonly runId: string;
  readonly trace: TraceWriter;

  constructor(
    repoPath: string,
    runId: string,
    private readonly baselineCommit: string,
    options: { diagnostics?: boolean } = {},
  ) {
    this.runId = validateRunId(runId);
    this.runPath = runPath(repoPath, this.runId);
    this.trace = new TraceWriter(repoPath, this.runId, options.diagnostics ?? false);
  }

  async initialize(): Promise<void> {
    await this.trace.initialize();
    await mkdir(resolveWithin(this.runPath, "plans"), { recursive: true, mode: 0o700 });
  }

  async writeState(state: RunState): Promise<void> {
    const validated = validateRunState(state);
    if (validated.runId !== this.runId || validated.baselineCommit !== this.baselineCommit) {
      throw new Error("Run state lineage does not match its artifact store");
    }
    await this.writeJson("state.json", validated);
    await this.trace.recordState(validated);
  }

  async writeArtifact<Key extends ArtifactKey>(
    key: Key,
    role: string,
    payload: ArtifactPayload<Key>,
    inputs: ArtifactInputHashes = {},
  ): Promise<StoredArtifact<ArtifactPayload<Key>>> {
    const definition = artifactDefinition(key);
    const inputKeys = Object.keys(inputs);
    if (!inputKeys.every(isArtifactKey)) {
      throw new Error(`Unknown artifact input for ${key}`);
    }
    validateArtifactInputKeys(key, inputKeys);
    const envelope: ArtifactEnvelope<ArtifactPayload<Key>> = {
      meta: {
        artifactVersion: ARTIFACT_VERSION,
        producerVersion: VERSION,
        runId: this.runId,
        baselineCommit: this.baselineCommit,
        role,
        createdAt: new Date().toISOString(),
        inputs,
      },
      payload: definition.validate(payload),
    };
    validateArtifactEnvelope(envelope);
    const content = `${JSON.stringify(envelope, null, 2)}\n`;
    const path = resolveWithin(this.runPath, definition.path);
    await mkdir(dirname(path), { recursive: true });
    await this.writeText(definition.path, content);
    const hash = hashContent(content);
    await this.trace.append({
      component: "artifact",
      event: "artifact.written",
      status: "completed",
      role,
      artifactKey: key,
      artifactHash: hash,
      payloadBytes: Buffer.byteLength(content),
    });
    return { path, hash, envelope };
  }

  async writeText(relativePath: string, content: string): Promise<string> {
    const path = resolveWithin(this.runPath, relativePath);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
    return path;
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }
}

export async function loadRunState(repoPath: string, runId: string): Promise<RunState> {
  const value = parseJson(
    await readFile(resolveWithin(runPath(repoPath, runId), "state.json"), "utf8"),
    "ChangeSafely run state",
  );
  assertStateVersion(value);
  const validated = validateRunState(value);
  if (validated.runId !== runId) {
    throw new Error("Run state identity does not match its directory");
  }
  return validated;
}

export async function loadVerifiedArtifact<Key extends ArtifactKey>(
  repoPath: string,
  state: RunState,
  artifactName: Key,
): Promise<ArtifactEnvelope<ArtifactPayload<Key>>> {
  const definition = artifactDefinition(artifactName);
  const content = await readFile(
    resolveWithin(runPath(repoPath, state.runId), definition.path),
    "utf8",
  );
  const expectedHash = state.artifacts[artifactName];
  if (!expectedHash || hashContent(content) !== expectedHash) {
    throw new Error(`Artifact hash mismatch: ${definition.path}`);
  }
  const value = parseJson(content, `ChangeSafely artifact ${definition.path}`);
  assertArtifactVersion(value);
  const envelope = validateArtifactEnvelope(value);
  if (
    envelope.meta.runId !== state.runId ||
    envelope.meta.baselineCommit !== state.baselineCommit
  ) {
    throw new Error(`Artifact lineage mismatch: ${definition.path}`);
  }
  const inputKeys = Object.keys(envelope.meta.inputs);
  if (!inputKeys.every(isArtifactKey)) {
    throw new Error(`Unknown artifact input in ${definition.path}`);
  }
  validateArtifactInputKeys(artifactName, inputKeys);
  for (const inputKey of inputKeys) {
    if (state.artifacts[inputKey] !== envelope.meta.inputs[inputKey]) {
      throw new Error(`Artifact input lineage mismatch: ${definition.path} <- ${inputKey}`);
    }
  }
  return {
    meta: envelope.meta,
    payload: artifactDefinition(artifactName, envelope.meta.artifactVersion).validate(
      envelope.payload,
    ),
  };
}

export async function loadSelectedPlanArtifacts(repoPath: string, state: RunState) {
  const contract = (await loadVerifiedArtifact(repoPath, state, "contract")).payload;
  const decision = (await loadVerifiedArtifact(repoPath, state, "decision")).payload;
  const plan = (
    await loadVerifiedArtifact(repoPath, state, parsePlanArtifactKey(decision.winnerPlanId))
  ).payload;
  return { contract, decision, plan };
}
