import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { relative, resolve, sep } from "node:path";
import spawn from "cross-spawn";
import Type from "typebox";
import { Compile } from "typebox/compile";
import { ChangeSafelyError, errorReasonCode } from "./errors.js";
import { OutputCapture } from "./output-capture.js";
import { analyzeTrace, type RunAnalytics } from "./run-analytics.js";
import type { RunState } from "./schemas.js";
import { VERSION } from "./version.js";

export const TRACE_VERSION = 1;
export const MANIFEST_VERSION = 1;

const SHA256_PATTERN = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const traceStatusSchema = Type.Unsafe<TraceStatus>(
  Type.String({ enum: ["started", "completed", "failed", "blocked", "info"] }),
);
const traceEventSchema = Type.Object(
  {
    traceVersion: Type.Literal(TRACE_VERSION),
    seq: Type.Integer({ minimum: 1 }),
    timestamp: Type.String({ pattern: timestampPattern }),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    component: Type.String({ minLength: 1, maxLength: 100 }),
    event: Type.String({ minLength: 1, maxLength: 100 }),
    status: traceStatusSchema,
    phase: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    parentThreadId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    itemType: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    toolFailed: Type.Optional(Type.Boolean()),
    commandId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    artifactKey: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    artifactHash: Type.Optional(Type.String({ pattern: SHA256_PATTERN })),
    commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })),
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    method: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    rpcCode: Type.Optional(Type.Integer()),
    argv: Type.Optional(
      Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 64 }),
    ),
    cwd: Type.Optional(Type.String({ maxLength: 4096 })),
    startedAt: Type.Optional(Type.String({ pattern: timestampPattern })),
    completedAt: Type.Optional(Type.String({ pattern: timestampPattern })),
    exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    signal: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
    timedOut: Type.Optional(Type.Boolean()),
    sandboxed: Type.Optional(Type.Boolean()),
    stdoutBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    stderrBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    stdoutSha256: Type.Optional(Type.String({ pattern: SHA256_PATTERN })),
    stderrSha256: Type.Optional(Type.String({ pattern: SHA256_PATTERN })),
    stdoutTruncated: Type.Optional(Type.Boolean()),
    stderrTruncated: Type.Optional(Type.Boolean()),
    diagnosticsPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 4 }),
    ),
    errorType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    stack: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
    ),
    promptSha256: Type.Optional(Type.String({ pattern: SHA256_PATTERN })),
    promptBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    outputSchemaSha256: Type.Optional(Type.String({ pattern: SHA256_PATTERN })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    effort: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    sandboxPolicy: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    validationPaths: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 })),
    payloadBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    payloadSha256: Type.Optional(Type.String({ pattern: SHA256_PATTERN })),
    runtimeVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    cachedInputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
const validateTraceEventSchema = Compile(traceEventSchema);
const roleProvenanceSchema = Type.Object(
  {
    role: Type.String({ minLength: 1, maxLength: 100 }),
    model: Type.String({ minLength: 1, maxLength: 255 }),
    effort: Type.String({ minLength: 1, maxLength: 100 }),
    sandboxPolicy: Type.String({ minLength: 1, maxLength: 100 }),
    promptSha256: Type.String({ pattern: SHA256_PATTERN }),
    promptBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    outputSchemaSha256: Type.Optional(Type.String({ pattern: SHA256_PATTERN })),
  },
  { additionalProperties: false },
);
const runManifestSchema = Type.Object(
  {
    manifestVersion: Type.Literal(MANIFEST_VERSION),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    changesafelyVersion: Type.String({ minLength: 1, maxLength: 100 }),
    nodeVersion: Type.String({ minLength: 1, maxLength: 100 }),
    gitVersion: Type.String({ minLength: 1, maxLength: 500 }),
    codexVersion: Type.String({ minLength: 1, maxLength: 500 }),
    appServerUserAgent: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    platform: Type.String({ minLength: 1, maxLength: 100 }),
    platformRelease: Type.String({ minLength: 1, maxLength: 200 }),
    architecture: Type.String({ minLength: 1, maxLength: 100 }),
    model: Type.String({ minLength: 1, maxLength: 255 }),
    startedAt: Type.String({ pattern: timestampPattern }),
    completedAt: Type.Union([Type.String({ pattern: timestampPattern }), Type.Null()]),
    resumeCount: Type.Integer({ minimum: 0 }),
    roles: Type.Array(roleProvenanceSchema),
  },
  { additionalProperties: false },
);
const validateRunManifestSchema = Compile(runManifestSchema);

type TraceStatus = "started" | "completed" | "failed" | "blocked" | "info";

export interface TraceEvent {
  traceVersion: typeof TRACE_VERSION;
  seq: number;
  timestamp: string;
  runId: string;
  component: string;
  event: string;
  status: TraceStatus;
  phase?: string;
  role?: string;
  durationMs?: number;
  reasonCode?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  itemType?: string;
  toolFailed?: boolean;
  commandId?: string;
  artifactKey?: string;
  artifactHash?: string;
  commit?: string;
  branch?: string;
  method?: string;
  rpcCode?: number;
  argv?: string[];
  cwd?: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  sandboxed?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  diagnosticsPaths?: string[];
  errorType?: string;
  stack?: string[];
  promptSha256?: string;
  promptBytes?: number;
  outputSchemaSha256?: string;
  model?: string;
  effort?: string;
  sandboxPolicy?: string;
  validationPaths?: string[];
  payloadBytes?: number;
  payloadSha256?: string;
  runtimeVersion?: string;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export type TraceEventInput = Omit<TraceEvent, "traceVersion" | "seq" | "timestamp" | "runId">;

export interface RoleProvenance {
  role: string;
  model: string;
  effort: string;
  sandboxPolicy: string;
  promptSha256: string;
  promptBytes?: number;
  outputSchemaSha256?: string;
}

export interface RunManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  runId: string;
  changesafelyVersion: string;
  nodeVersion: string;
  gitVersion: string;
  codexVersion: string;
  appServerUserAgent: string | null;
  platform: string;
  platformRelease: string;
  architecture: string;
  model: string;
  startedAt: string;
  completedAt: string | null;
  resumeCount: number;
  roles: RoleProvenance[];
}

export interface TraceDocument {
  traceVersion: typeof TRACE_VERSION;
  runId: string;
  tracePath: string;
  events: TraceEvent[];
  analytics: RunAnalytics;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentEvidence(value: string): { payloadBytes: number; payloadSha256: string } {
  return { payloadBytes: Buffer.byteLength(value), payloadSha256: sha256(value) };
}

function validateTraceEvent(value: unknown): TraceEvent {
  if (!validateTraceEventSchema.Check(value)) {
    throw new ChangeSafelyError("INVALID_TRACE", "Trace contains an invalid event", {
      exitCode: 2,
      nextAction: "Inspect the local trace file and start a new run if it is damaged.",
    });
  }
  return value as TraceEvent;
}

function parseRunManifest(content: string, runId: string): RunManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ChangeSafelyError("INVALID_MANIFEST", "Run manifest contains invalid JSON", {
      exitCode: 2,
      nextAction: "Inspect the local manifest and start a new run if it is damaged.",
    });
  }
  if (!validateRunManifestSchema.Check(value) || (value as RunManifest).runId !== runId) {
    throw new ChangeSafelyError("INVALID_MANIFEST", "Run manifest is invalid or incompatible", {
      exitCode: 2,
      nextAction: "Inspect the local manifest and start a new run if it is damaged.",
    });
  }
  return value as RunManifest;
}

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

async function restrictMode(path: string, mode: number): Promise<void> {
  if (process.platform !== "win32") await chmod(path, mode);
}

async function commandVersion(command: string): Promise<string> {
  const output = new OutputCapture(16 * 1024);
  try {
    const child = spawn(command, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => output.append(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} --version timed out`));
      }, 2_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const value = output.snapshot().tail.trim();
    return exitCode === 0 && value ? value.slice(0, 500) : "unavailable";
  } catch {
    return "unavailable";
  }
}

function stateTraceStatus(state: RunState): TraceStatus {
  if (state.status === "FAILED") return "failed";
  if (
    ["BLOCKED", "HUMAN_DECISION_REQUIRED", "BASELINE_CHANGED", "REPLAN_REQUIRED"].includes(
      state.status,
    )
  ) {
    return "blocked";
  }
  if (state.status === "PLANNED" || state.status === "VERIFIED") return "completed";
  return "info";
}

function validationPaths(error: unknown): string[] | undefined {
  if (typeof error !== "object" || error === null || !("validationErrors" in error))
    return undefined;
  const values = (error as { validationErrors?: unknown }).validationErrors;
  if (!Array.isArray(values)) return undefined;
  const paths = values.flatMap((value) => {
    if (typeof value !== "object" || value === null || !("instancePath" in value)) return [];
    const path = (value as { instancePath?: unknown }).instancePath;
    return typeof path === "string" ? [path || "/"] : [];
  });
  return paths.length > 0 ? paths.slice(0, 32) : undefined;
}

export class TraceWriter {
  readonly runPath: string;
  readonly tracePath: string;
  readonly manifestPath: string;
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private nextSeq = 1;
  private activePhase: string | undefined;
  private manifest: RunManifest | undefined;

  constructor(
    readonly repoPath: string,
    readonly runId: string,
    readonly diagnostics = false,
  ) {
    this.runPath = resolve(repoPath, ".changesafely", "runs", runId);
    this.tracePath = resolve(this.runPath, "trace.jsonl");
    this.manifestPath = resolve(this.runPath, "manifest.json");
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async initializeDirect(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.runPath, { recursive: true, mode: 0o700 });
    await restrictMode(this.runPath, 0o700);
    let content = "";
    try {
      content = await readFile(this.tracePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const events = parseTraceContent(content, this.runId);
    this.nextSeq = (events.at(-1)?.seq ?? 0) + 1;
    for (const event of events) {
      if (event.component === "workflow" && event.event === "phase.started") {
        this.activePhase = event.phase;
      }
      if (
        event.component === "workflow" &&
        event.event === "phase.finished" &&
        event.phase === this.activePhase
      ) {
        this.activePhase = undefined;
      }
    }
    const handle = await open(this.tracePath, "a", 0o600);
    await handle.close();
    await restrictMode(this.tracePath, 0o600);
    try {
      this.manifest = parseRunManifest(await readFile(this.manifestPath, "utf8"), this.runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.initialized = true;
  }

  async initialize(): Promise<void> {
    await this.enqueue(() => this.initializeDirect());
  }

  private async appendDirect(inputs: TraceEventInput[]): Promise<TraceEvent[]> {
    await this.initializeDirect();
    const events = inputs.map((input, index) =>
      validateTraceEvent({
        traceVersion: TRACE_VERSION,
        seq: this.nextSeq + index,
        timestamp: new Date().toISOString(),
        runId: this.runId,
        ...input,
      }),
    );
    if (events.length > 0) {
      const handle = await open(this.tracePath, "a", 0o600);
      try {
        await handle.writeFile(
          events.map((event) => `${JSON.stringify(event)}\n`).join(""),
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await restrictMode(this.tracePath, 0o600);
      this.nextSeq += events.length;
    }
    return events;
  }

  async append(input: TraceEventInput): Promise<TraceEvent> {
    const [event] = await this.enqueue(() => this.appendDirect([input]));
    if (!event) throw new Error("Trace event was not written");
    return event;
  }

  async recordState(state: RunState): Promise<void> {
    await this.enqueue(async () => {
      await this.initializeDirect();
      const inputs: TraceEventInput[] = [];
      if (this.activePhase !== state.phase) {
        if (this.activePhase) {
          inputs.push({
            component: "workflow",
            event: "phase.finished",
            status: "completed",
            phase: this.activePhase,
          });
        }
        inputs.push({
          component: "workflow",
          event: "phase.started",
          status: "started",
          phase: state.phase,
        });
        this.activePhase = state.phase;
      }
      const status = stateTraceStatus(state);
      const commit = state.implementationCommit || state.testCommit;
      inputs.push({
        component: "state",
        event: "state.transition",
        status,
        phase: state.phase,
        ...(state.branch && commit ? { commit } : {}),
      });
      if (status !== "info") {
        inputs.push({
          component: "workflow",
          event: "phase.finished",
          status,
          phase: state.phase,
        });
        this.activePhase = undefined;
      }
      await this.appendDirect(inputs);
      if (status !== "info") {
        await this.completeManifestDirect();
      } else if (this.manifest?.completedAt) {
        this.manifest.completedAt = null;
        await this.writeManifestDirect();
      }
    });
  }

  async initializeManifest(model: string): Promise<void> {
    const [gitVersion, codexVersion] = await Promise.all([
      commandVersion("git"),
      commandVersion("codex"),
    ]);
    await this.enqueue(async () => {
      await this.initializeDirect();
      if (this.manifest) return;
      this.manifest = {
        manifestVersion: MANIFEST_VERSION,
        runId: this.runId,
        changesafelyVersion: VERSION,
        nodeVersion: process.version,
        gitVersion,
        codexVersion,
        appServerUserAgent: null,
        platform: platform(),
        platformRelease: release(),
        architecture: arch(),
        model: model || "default",
        startedAt: new Date().toISOString(),
        completedAt: null,
        resumeCount: 0,
        roles: [],
      };
      await this.writeManifestDirect();
    });
  }

  async recordRoleProvenance(role: RoleProvenance): Promise<void> {
    await this.enqueue(async () => {
      await this.initializeDirect();
      if (!this.manifest) return;
      this.manifest.roles.push(role);
      await this.writeManifestDirect();
    });
  }

  async recordAppServerVersion(userAgent: string): Promise<void> {
    await this.enqueue(async () => {
      await this.initializeDirect();
      if (!this.manifest) return;
      this.manifest.appServerUserAgent = userAgent.slice(0, 500);
      await this.writeManifestDirect();
    });
  }

  async markResumed(): Promise<void> {
    await this.enqueue(async () => {
      await this.initializeDirect();
      if (this.manifest) {
        this.manifest.completedAt = null;
        this.manifest.resumeCount += 1;
        await this.writeManifestDirect();
      }
      await this.appendDirect([{ component: "workflow", event: "run.resumed", status: "started" }]);
    });
  }

  async completeManifest(): Promise<void> {
    await this.enqueue(() => this.completeManifestDirect());
  }

  private async completeManifestDirect(): Promise<void> {
    await this.initializeDirect();
    if (!this.manifest) return;
    this.manifest.completedAt = new Date().toISOString();
    await this.writeManifestDirect();
  }

  private async writeManifestDirect(): Promise<void> {
    if (!this.manifest) return;
    const temporaryPath = `${this.manifestPath}.tmp-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(this.manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await restrictMode(temporaryPath, 0o600);
    await rename(temporaryPath, this.manifestPath);
    await restrictMode(this.manifestPath, 0o600);
  }

  async writeDiagnostic(name: string, content: string): Promise<string | undefined> {
    if (!this.diagnostics || content.length === 0) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name)) {
      throw new Error(`Invalid diagnostic filename: ${name}`);
    }
    return this.enqueue(async () => {
      await this.initializeDirect();
      const directory = resolve(this.runPath, "diagnostics");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await restrictMode(directory, 0o700);
      const path = resolve(directory, name);
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      await restrictMode(path, 0o600);
      return posixPath(relative(this.runPath, path));
    });
  }

  relativeCwd(cwd: string): string {
    const value = relative(this.repoPath, cwd);
    if (value === "") return ".";
    if (value === ".." || value.startsWith(`..${sep}`)) return "<outside-repository>";
    return posixPath(value);
  }

  sanitizedStack(error: unknown): string[] | undefined {
    if (!(error instanceof Error) || !error.stack) return undefined;
    const replacements = [
      [this.repoPath, "<repo>"],
      [homedir(), "<home>"],
      [process.cwd(), "<cwd>"],
    ] as const;
    const lines = error.stack.split("\n").slice(1, 13);
    const sanitized = lines.map((line) => {
      let value = line.trim();
      for (const [from, to] of replacements) {
        if (from) value = value.replaceAll(from, to);
      }
      return value.slice(0, 1000);
    });
    return sanitized.length > 0 ? sanitized : undefined;
  }

  async recordFailure(
    component: string,
    event: string,
    error: unknown,
    extra: Partial<TraceEventInput> = {},
  ): Promise<void> {
    const input: TraceEventInput = {
      component,
      event,
      status: "failed",
      reasonCode: errorReasonCode(error),
      errorType: error instanceof Error ? error.name : typeof error,
    };
    const stack = this.sanitizedStack(error);
    if (stack) input.stack = stack;
    const paths = validationPaths(error);
    if (paths) input.validationPaths = paths;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) (input as unknown as Record<string, unknown>)[key] = value;
    }
    await this.append(input);
  }
}

export function parseTraceJsonl(content: string): TraceEvent[] {
  if (!content.trim()) return [];
  const events = content
    .trimEnd()
    .split("\n")
    .map((line) => {
      try {
        return validateTraceEvent(JSON.parse(line));
      } catch (error) {
        if (error instanceof ChangeSafelyError) throw error;
        throw new ChangeSafelyError("INVALID_TRACE", "Trace contains invalid JSON", {
          exitCode: 2,
          nextAction: "Inspect the local trace file and start a new run if it is damaged.",
        });
      }
    });
  const runId = events[0]?.runId;
  for (const [index, event] of events.entries()) {
    if (!runId || event.runId !== runId || event.seq !== index + 1) {
      throw new ChangeSafelyError("INVALID_TRACE", "Trace sequence or run identity is invalid", {
        exitCode: 2,
        nextAction: "Inspect the local trace file and start a new run if it is damaged.",
      });
    }
  }
  return events;
}

function parseTraceContent(content: string, runId: string): TraceEvent[] {
  const events = parseTraceJsonl(content);
  if (events.some((event) => event.runId !== runId)) {
    throw new ChangeSafelyError("INVALID_TRACE", "Trace run identity is invalid", {
      exitCode: 2,
      nextAction: "Inspect the local trace file and start a new run if it is damaged.",
    });
  }
  return events;
}

export async function loadTrace(repoPath: string, runId: string): Promise<TraceDocument> {
  const tracePath = resolve(repoPath, ".changesafely", "runs", runId, "trace.jsonl");
  const events = parseTraceContent(await readFile(tracePath, "utf8"), runId);
  return { traceVersion: TRACE_VERSION, runId, tracePath, events, analytics: analyzeTrace(events) };
}

export function formatTrace(document: TraceDocument): string {
  const lines = document.events.map((event) => {
    const context = [
      event.phase ? `phase=${event.phase}` : "",
      event.role ? `role=${event.role}` : "",
      event.method ? `method=${event.method}` : "",
      event.durationMs === undefined ? "" : `duration=${event.durationMs}ms`,
      event.reasonCode ? `reason=${event.reasonCode}` : "",
      event.artifactKey ? `artifact=${event.artifactKey}` : "",
      event.commandId ? `command=${event.commandId}` : "",
      event.commit ? `commit=${event.commit}` : "",
      event.branch ? `branch=${event.branch}` : "",
      event.threadId ? `thread=${event.threadId}` : "",
      event.parentThreadId ? `parentThread=${event.parentThreadId}` : "",
      event.turnId ? `turn=${event.turnId}` : "",
      event.itemType ? `item=${event.itemType}` : "",
      event.argv ? `argv=${JSON.stringify(event.argv)}` : "",
      event.artifactHash ? `hash=${event.artifactHash}` : "",
    ].filter(Boolean);
    return `${event.timestamp} #${String(event.seq).padStart(4, "0")} ${event.component}.${event.event} ${event.status}${context.length > 0 ? ` ${context.join(" ")}` : ""}`;
  });
  const tokens = document.analytics.tokens;
  const summary = [
    `Elapsed: ${document.analytics.traceWallTimeMs ?? "n/a"} ms`,
    `Model time: ${document.analytics.modelTimeMs} ms`,
    `Commands: ${document.analytics.commands} (${document.analytics.commandFailures} failed)`,
    `Tokens: ${tokens.totalTokens ?? "n/a"} total, ${tokens.inputTokens ?? "n/a"} input, ${tokens.cachedInputTokens ?? "n/a"} cached, ${tokens.outputTokens ?? "n/a"} output`,
  ];
  return [
    `Run: ${document.runId}`,
    `Trace: ${document.tracePath}`,
    ...summary,
    "",
    ...lines,
    "",
  ].join("\n");
}

export function promptEvidence(
  prompt: string,
  outputSchema?: object,
): {
  promptSha256: string;
  promptBytes: number;
  outputSchemaSha256?: string;
} {
  return {
    promptSha256: sha256(prompt),
    promptBytes: Buffer.byteLength(prompt),
    ...(outputSchema ? { outputSchemaSha256: sha256(JSON.stringify(outputSchema)) } : {}),
  };
}

export function sandboxPolicyName(policy: { type: string; networkAccess?: unknown }): string {
  const network =
    policy.networkAccess === false ? "off" : String(policy.networkAccess ?? "default");
  return `${policy.type}:network-${network}`;
}
