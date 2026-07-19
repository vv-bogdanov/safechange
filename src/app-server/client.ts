import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import spawn from "cross-spawn";
import {
  createJSONRPCErrorResponse,
  JSONRPCClient,
  JSONRPCErrorException,
  type JSONRPCRequest,
  type JSONRPCResponse,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from "json-rpc-2.0";
import { safeEnvironment } from "../environment.js";
import { ChangeSafelyError } from "../errors.js";
import { OutputCapture } from "../output-capture.js";
import {
  contentEvidence,
  promptEvidence,
  sandboxPolicyName,
  type TraceEventInput,
  type TraceWriter,
} from "../trace.js";
import { VERSION } from "../version.js";
import type { InitializeParams } from "./generated/types/InitializeParams.js";
import type { InitializeResponse } from "./generated/types/InitializeResponse.js";
import type { JsonValue } from "./generated/types/serde_json/JsonValue.js";
import type { ItemCompletedNotification } from "./generated/types/v2/ItemCompletedNotification.js";
import type { SandboxPolicy } from "./generated/types/v2/SandboxPolicy.js";
import type { ThreadForkParams } from "./generated/types/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "./generated/types/v2/ThreadForkResponse.js";
import type { ThreadResumeParams } from "./generated/types/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/types/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/types/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/types/v2/ThreadStartResponse.js";
import type { ThreadTokenUsageUpdatedNotification } from "./generated/types/v2/ThreadTokenUsageUpdatedNotification.js";
import type { TurnCompletedNotification } from "./generated/types/v2/TurnCompletedNotification.js";
import type { TurnInterruptParams } from "./generated/types/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/types/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/types/v2/TurnStartResponse.js";

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface TurnWaiter {
  resolve(notification: TurnCompletedNotification): void;
  reject(error: Error): void;
}

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  trace?: TraceWriter;
  permissionProfile?: string;
}

export interface RunTurnOptions {
  cwd: string;
  sandboxPolicy: SandboxPolicy;
  outputSchema?: object;
  timeoutMs?: number;
  effort?: string;
  model?: string;
  role?: string;
  phase?: string;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  status: string;
  message: string;
}

export class AppServerError extends ChangeSafelyError {
  constructor(
    message: string,
    public readonly rpcError?: RpcError,
  ) {
    super("APP_SERVER_ERROR", message, {
      nextAction: "Check Codex App Server compatibility and retry the run.",
    });
    this.name = "AppServerError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function withoutVersion(message: JSONRPCRequest | JSONRPCResponse): object {
  const { jsonrpc: _, ...appServerMessage } = message;
  return appServerMessage;
}

function isRpcId(value: unknown): value is number | string {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function validateRpcError(value: unknown): RpcError | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    !Number.isFinite(value.code) ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    ...(hasOwn(value, "data") ? { data: value.data } : {}),
  };
}

function validateInitializeResponse(value: unknown): InitializeResponse {
  if (
    !isRecord(value) ||
    typeof value.userAgent !== "string" ||
    typeof value.codexHome !== "string" ||
    typeof value.platformFamily !== "string" ||
    typeof value.platformOs !== "string"
  ) {
    throw new AppServerError("Invalid initialize response from App Server");
  }
  return value as unknown as InitializeResponse;
}

function validateThreadResponse<T>(value: unknown, method: string): T {
  if (!isRecord(value) || !isRecord(value.thread) || typeof value.thread.id !== "string") {
    throw new AppServerError(`Invalid ${method} response from App Server`);
  }
  return value as T;
}

function validateTurnStartResponse(value: unknown): TurnStartResponse {
  if (!isRecord(value) || !isRecord(value.turn) || typeof value.turn.id !== "string") {
    throw new AppServerError("Invalid turn/start response from App Server");
  }
  return value as unknown as TurnStartResponse;
}

function validateItemCompleted(value: unknown): ItemCompletedNotification | undefined {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.completedAtMs !== "number" ||
    !isRecord(value.item) ||
    typeof value.item.type !== "string"
  ) {
    return undefined;
  }
  if (value.item.type === "agentMessage" && typeof value.item.text !== "string") {
    return undefined;
  }
  return value as unknown as ItemCompletedNotification;
}

function validateTurnCompleted(value: unknown): TurnCompletedNotification | undefined {
  if (!isRecord(value) || typeof value.threadId !== "string" || !isRecord(value.turn)) {
    return undefined;
  }
  const turn = value.turn;
  const validStatus = ["completed", "interrupted", "failed", "inProgress"].includes(
    String(turn.status),
  );
  const validItems =
    Array.isArray(turn.items) &&
    turn.items.every(
      (item) =>
        isRecord(item) &&
        typeof item.type === "string" &&
        (item.type !== "agentMessage" || typeof item.text === "string"),
    );
  const validError =
    turn.error === null || (isRecord(turn.error) && typeof turn.error.message === "string");
  const nullableNumber = (item: unknown) => item === null || typeof item === "number";
  if (
    typeof turn.id !== "string" ||
    !validStatus ||
    !validItems ||
    !["notLoaded", "summary", "full"].includes(String(turn.itemsView)) ||
    !validError ||
    !nullableNumber(turn.startedAt) ||
    !nullableNumber(turn.completedAt) ||
    !nullableNumber(turn.durationMs)
  ) {
    return undefined;
  }
  return value as unknown as TurnCompletedNotification;
}

function validateTokenUsage(value: unknown): ThreadTokenUsageUpdatedNotification | undefined {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    !isRecord(value.tokenUsage) ||
    !validTokenBreakdown(value.tokenUsage.total) ||
    !validTokenBreakdown(value.tokenUsage.last) ||
    !(
      value.tokenUsage.modelContextWindow === null ||
      validNonnegativeInteger(value.tokenUsage.modelContextWindow)
    )
  ) {
    return undefined;
  }
  return value as unknown as ThreadTokenUsageUpdatedNotification;
}

function validTokenBreakdown(value: unknown): boolean {
  return (
    isRecord(value) &&
    [
      value.totalTokens,
      value.inputTokens,
      value.cachedInputTokens,
      value.outputTokens,
      value.reasoningOutputTokens,
    ].every(validNonnegativeInteger)
  );
}

const tracedToolItemTypes = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
]);

function toolItemTrace(
  item: unknown,
): Pick<TraceEventInput, "itemType" | "toolFailed" | "durationMs"> | undefined {
  if (!isRecord(item) || typeof item.type !== "string" || !tracedToolItemTypes.has(item.type)) {
    return undefined;
  }
  const failed =
    item.status === "failed" ||
    item.status === "declined" ||
    item.success === false ||
    (typeof item.exitCode === "number" && item.exitCode !== 0);
  return {
    itemType: item.type,
    toolFailed: failed,
    ...(validNonnegativeInteger(item.durationMs) ? { durationMs: item.durationMs } : {}),
  };
}

function validNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class AppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private readonly rpc: JSONRPCServerAndClient;
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly completedTurns = new Map<string, TurnCompletedNotification>();
  private readonly agentMessages = new Map<string, string>();
  private fatalError: AppServerError | undefined;
  private abortListener: (() => void) | undefined;
  private trace: TraceWriter | undefined;
  private readonly stderr = new OutputCapture(64 * 1024);
  private stderrRecorded = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly pendingTasks = new Set<Promise<void>>();
  private pendingTaskError: unknown;

  constructor(private readonly options: AppServerClientOptions = {}) {
    this.trace = options.trace;
    const server = new JSONRPCServer({
      errorListener: (message) => this.failProtocol(message),
    });
    server.addMethod("item/completed", (params) =>
      this.handleNotification("item/completed", params),
    );
    server.addMethod("turn/completed", (params) =>
      this.handleNotification("turn/completed", params),
    );
    server.addMethod("thread/tokenUsage/updated", (params) =>
      this.handleNotification("thread/tokenUsage/updated", params),
    );
    const client = new JSONRPCClient((message) => this.write(withoutVersion(message)));
    this.rpc = new JSONRPCServerAndClient(server, client, {
      errorListener: (message) => this.failProtocol(message),
    });
  }

  setTrace(trace: TraceWriter): void {
    this.trace = trace;
  }

  async start(): Promise<InitializeResponse> {
    if (this.process) {
      throw new AppServerError("App Server is already started");
    }
    if (this.options.signal?.aborted) {
      throw new AppServerError("App Server start was aborted");
    }

    await this.trace?.append({
      component: "app-server",
      event: "lifecycle",
      status: "started",
    });
    const startedAt = Date.now();
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    this.process = spawn(command, args, {
      cwd: this.options.cwd,
      env: safeEnvironment(this.options.env),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.process.on("exit", (code, signal) => {
      if (this.closing) {
        this.trackTask(
          this.trace?.append({
            component: "app-server",
            event: "process.exited",
            status: "completed",
            exitCode: code,
            signal,
          }),
        );
        return;
      }
      const error = new AppServerError(`App Server exited (${signal ?? String(code)})`);
      this.trackTask(
        this.trace?.recordFailure("app-server", "process.exited", error, {
          exitCode: code,
          signal,
        }),
      );
      this.failAll(error);
    });
    this.process.on("error", (error) => {
      this.trackTask(this.trace?.recordFailure("app-server", "process.error", error));
      this.failAll(new AppServerError(error.message));
    });
    this.process.stderr.on("data", (chunk: Buffer) => this.stderr.append(chunk));

    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.abortListener = () => {
      this.failAll(new AppServerError("App Server operation was aborted"));
      void this.close().catch(() => undefined);
    };
    this.options.signal?.addEventListener("abort", this.abortListener, { once: true });

    const params: InitializeParams = {
      clientInfo: {
        name: "changesafely",
        title: "ChangeSafely",
        version: VERSION,
      },
      capabilities: null,
    };
    const initialized = validateInitializeResponse(
      await this.request<InitializeResponse>("initialize", params),
    );
    this.notify("initialized", {});
    await this.trace?.recordAppServerVersion(initialized.userAgent);
    await this.trace?.append({
      component: "app-server",
      event: "lifecycle",
      status: "completed",
      durationMs: Date.now() - startedAt,
      runtimeVersion: initialized.userAgent,
    });
    return initialized;
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const requestParams = this.options.permissionProfile
      ? configuredPermissionThread(params, this.options.permissionProfile)
      : params;
    return this.request("thread/start", requestParams).then((value) =>
      validateThreadResponse<ThreadStartResponse>(value, "thread/start"),
    );
  }

  async forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> {
    const response = validateThreadResponse<ThreadForkResponse>(
      await this.request("thread/fork", params),
      "thread/fork",
    );
    await this.trace?.append({
      component: "app-server",
      event: "thread.forked",
      status: "completed",
      threadId: response.thread.id,
      parentThreadId: params.threadId,
      ...(params.lastTurnId ? { turnId: params.lastTurnId } : {}),
    });
    return response;
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params).then((value) =>
      validateThreadResponse<ThreadResumeResponse>(value, "thread/resume"),
    );
  }

  async runTurn(threadId: string, prompt: string, options: RunTurnOptions): Promise<TurnResult> {
    const role = options.role ?? "unknown";
    const evidence = promptEvidence(prompt, options.outputSchema);
    const sandboxPolicy = this.options.permissionProfile
      ? `permissions:${this.options.permissionProfile}`
      : sandboxPolicyName(options.sandboxPolicy);
    const model = options.model ?? "default";
    const effort = options.effort ?? "default";
    await this.trace?.recordRoleProvenance({
      role,
      model,
      effort,
      sandboxPolicy,
      ...evidence,
    });
    const roleStartedAt = Date.now();
    await this.trace?.append({
      component: "role",
      event: "turn.executed",
      status: "started",
      ...(options.phase ? { phase: options.phase } : {}),
      role,
      threadId,
      model,
      effort,
      sandboxPolicy,
      ...evidence,
    });
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: options.cwd,
      approvalPolicy: "never",
      ...(this.options.permissionProfile ? {} : { sandboxPolicy: options.sandboxPolicy }),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema as JsonValue } : {}),
    };
    let turnId: string | undefined;
    try {
      const started = validateTurnStartResponse(
        await this.request<TurnStartResponse>("turn/start", params),
      );
      turnId = started.turn.id;

      let completion: TurnCompletedNotification;
      try {
        completion = await this.waitForTurn(
          turnId,
          options.timeoutMs ?? this.options.turnTimeoutMs ?? 300_000,
        );
      } catch (error) {
        this.agentMessages.delete(turnId);
        const interrupt: TurnInterruptParams = { threadId, turnId };
        await this.request("turn/interrupt", interrupt).catch(() => undefined);
        throw error;
      }

      if (completion.turn.status !== "completed") {
        this.agentMessages.delete(turnId);
        throw new AppServerError(
          `Turn ${turnId} ended with ${completion.turn.status}: ${completion.turn.error?.message ?? "no details"}`,
        );
      }

      const completedMessage = [...completion.turn.items]
        .reverse()
        .find((item) => item.type === "agentMessage");
      const message =
        completedMessage?.type === "agentMessage"
          ? completedMessage.text
          : (this.agentMessages.get(turnId) ?? "");
      this.agentMessages.delete(turnId);

      await this.trace?.append({
        component: "role",
        event: "turn.executed",
        status: "completed",
        ...(options.phase ? { phase: options.phase } : {}),
        role,
        threadId,
        turnId,
        durationMs: Date.now() - roleStartedAt,
        model,
        effort,
        sandboxPolicy,
        ...evidence,
      });
      return {
        threadId,
        turnId,
        status: completion.turn.status,
        message,
      };
    } catch (error) {
      await this.trace?.recordFailure("role", "turn.executed", error, {
        ...(options.phase ? { phase: options.phase } : {}),
        role,
        threadId,
        ...(turnId ? { turnId } : {}),
        durationMs: Date.now() - roleStartedAt,
        model,
        effort,
        sandboxPolicy,
        ...evidence,
      });
      throw error;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeDirect();
    return this.closePromise;
  }

  private async closeDirect(): Promise<void> {
    if (this.abortListener) {
      this.options.signal?.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
    const child = this.process;
    if (!child) {
      await this.recordStderr();
      await this.flushPendingTasks();
      return;
    }

    this.lines?.close();
    this.process = undefined;
    this.closing = true;
    if (child.exitCode !== null || child.signalCode !== null) {
      await this.recordStderr();
      await this.flushPendingTasks();
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    await this.recordStderr();
    await this.flushPendingTasks();
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const startedAt = Date.now();
    const context = rpcContext(params);
    await this.trace?.append({
      component: "app-server",
      event: "rpc.request",
      status: "started",
      method,
      ...context,
    });
    try {
      const value = (await this.rpc.client
        .timeout(this.options.requestTimeoutMs ?? 10_000, (id) =>
          createJSONRPCErrorResponse(id, -32_000, `App Server request ${method} timed out`),
        )
        .request(method, params)) as T;
      await this.trace?.append({
        component: "app-server",
        event: "rpc.request",
        status: "completed",
        method,
        durationMs: Date.now() - startedAt,
        ...context,
      });
      return value;
    } catch (error) {
      const requestTimedOut =
        error instanceof JSONRPCErrorException && /\btimed out$/i.test(error.message);
      await this.trace?.recordFailure("app-server", "rpc.request", error, {
        method,
        durationMs: Date.now() - startedAt,
        ...context,
        ...(error instanceof JSONRPCErrorException ? { rpcCode: error.code } : {}),
        ...(requestTimedOut ? { reasonCode: "APP_SERVER_REQUEST_TIMEOUT" } : {}),
      });
      if (error instanceof JSONRPCErrorException) {
        throw new AppServerError(error.message, {
          code: error.code,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        });
      }
      throw error;
    }
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.process?.stdin.writable) {
      throw new AppServerError("App Server stdin is not writable");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failProtocol("Invalid JSON from App Server", contentEvidence(line));
      return;
    }

    if (!isRecord(message)) {
      this.failProtocol("Invalid message from App Server", contentEvidence(line));
      return;
    }

    if (hasOwn(message, "id") && typeof message.method === "string") {
      if (!isRpcId(message.id)) {
        this.failProtocol("Invalid request id from App Server", contentEvidence(line));
        return;
      }
    } else if (hasOwn(message, "id")) {
      if (!isRpcId(message.id) || (!hasOwn(message, "result") && !hasOwn(message, "error"))) {
        this.failProtocol("Invalid response from App Server", contentEvidence(line));
        return;
      }
      if (hasOwn(message, "error") && !validateRpcError(message.error)) {
        this.failProtocol("Invalid error response from App Server", contentEvidence(line));
        return;
      }
    } else if (typeof message.method !== "string") {
      this.failProtocol("Invalid notification from App Server", contentEvidence(line));
      return;
    }

    void this.rpc
      .receiveAndSend({ jsonrpc: "2.0", ...message } as JSONRPCRequest | JSONRPCResponse)
      .catch((error) =>
        this.failProtocol(
          error instanceof Error ? error.message : "Invalid JSON-RPC message",
          contentEvidence(line),
        ),
      );
  }

  private handleNotification(method: string, value: unknown): void {
    if (method === "thread/tokenUsage/updated") {
      const params = validateTokenUsage(value);
      if (!params) {
        this.failProtocol(
          "Invalid thread/tokenUsage/updated notification from App Server",
          contentEvidence(JSON.stringify(value)),
        );
        return;
      }
      const total = params.tokenUsage.total;
      this.trackTask(
        this.trace?.append({
          component: "app-server",
          event: "token.usage",
          status: "info",
          threadId: params.threadId,
          turnId: params.turnId,
          totalTokens: total.totalTokens,
          inputTokens: total.inputTokens,
          cachedInputTokens: total.cachedInputTokens,
          outputTokens: total.outputTokens,
          reasoningTokens: total.reasoningOutputTokens,
        }),
      );
      return;
    }

    if (method === "item/completed") {
      const params = validateItemCompleted(value);
      if (!params) {
        this.failProtocol(
          "Invalid item/completed notification from App Server",
          contentEvidence(JSON.stringify(value)),
        );
        return;
      }
      if (params.item.type === "agentMessage") {
        this.agentMessages.set(params.turnId, params.item.text);
      }
      const itemTrace = toolItemTrace(params.item);
      if (itemTrace) {
        this.trackTask(
          this.trace?.append({
            component: "app-server",
            event: "item.completed",
            status: itemTrace.toolFailed ? "failed" : "completed",
            threadId: params.threadId,
            turnId: params.turnId,
            ...itemTrace,
          }),
        );
      }
      return;
    }

    if (method !== "turn/completed") return;
    const params = validateTurnCompleted(value);
    if (!params) {
      this.failProtocol(
        "Invalid turn/completed notification from App Server",
        contentEvidence(JSON.stringify(value)),
      );
      return;
    }
    const waiter = this.turnWaiters.get(params.turn.id);
    if (waiter) {
      this.turnWaiters.delete(params.turn.id);
      waiter.resolve(params);
    } else {
      this.completedTurns.set(params.turn.id, params);
      if (this.completedTurns.size > 100) {
        const oldest = this.completedTurns.keys().next().value;
        if (typeof oldest === "string") this.completedTurns.delete(oldest);
      }
    }
  }

  private waitForTurn(turnId: string, timeoutMs: number): Promise<TurnCompletedNotification> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new AppServerError(`Turn ${turnId} timed out`));
      }, timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: (notification) => {
          clearTimeout(timer);
          resolve(notification);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private failAll(error: Error): void {
    this.rpc.rejectAllPendingRequests(error.message);
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
  }

  private failProtocol(message: string, evidence: Partial<TraceEventInput> = {}): void {
    const error = new AppServerError(message);
    this.fatalError = error;
    this.trackTask(this.trace?.recordFailure("app-server", "protocol.message", error, evidence));
    this.failAll(error);
    void this.close().catch(() => undefined);
  }

  private trackTask(task: Promise<unknown> | undefined): void {
    if (!task) return;
    const tracked = task
      .then(
        () => undefined,
        (error: unknown) => {
          this.pendingTaskError ??= error;
        },
      )
      .finally(() => this.pendingTasks.delete(tracked));
    this.pendingTasks.add(tracked);
  }

  private async flushPendingTasks(): Promise<void> {
    while (this.pendingTasks.size > 0) await Promise.all(this.pendingTasks);
    if (this.pendingTaskError) throw this.pendingTaskError;
  }

  private async recordStderr(): Promise<void> {
    if (this.stderrRecorded) return;
    this.stderrRecorded = true;
    const snapshot = this.stderr.snapshot();
    const diagnosticPath = await this.trace?.writeDiagnostic(
      `app-server-${randomUUID()}.stderr.log`,
      snapshot.tail,
    );
    await this.trace?.append({
      component: "app-server",
      event: "stderr.captured",
      status: "info",
      stderrBytes: snapshot.bytes,
      stderrSha256: snapshot.sha256,
      stderrTruncated: snapshot.truncated,
      ...(diagnosticPath ? { diagnosticsPaths: [diagnosticPath] } : {}),
    });
  }
}

function configuredPermissionThread(
  params: ThreadStartParams,
  permissionProfile: string,
): ThreadStartParams {
  const { sandbox: _sandbox, ...rest } = params;
  return {
    ...rest,
    config: { ...params.config, default_permissions: permissionProfile },
  };
}

function rpcContext(params: unknown): Pick<TraceEventInput, "threadId" | "turnId"> {
  if (!isRecord(params)) return {};
  return {
    ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
    ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
  };
}
