import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { safeEnvironment } from "../environment.js";
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
import type { TurnCompletedNotification } from "./generated/types/v2/TurnCompletedNotification.js";
import type { TurnInterruptParams } from "./generated/types/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/types/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/types/v2/TurnStartResponse.js";

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: RpcError;
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
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
}

export interface RunTurnOptions {
  cwd: string;
  sandboxPolicy: SandboxPolicy;
  outputSchema?: object;
  timeoutMs?: number;
  effort?: string;
  model?: string;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  status: string;
  message: string;
}

export class AppServerError extends Error {
  constructor(
    message: string,
    public readonly rpcError?: RpcError,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

export class AppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly completedTurns = new Map<string, TurnCompletedNotification>();
  private readonly agentMessages = new Map<string, string>();
  private stderr = "";

  constructor(private readonly options: AppServerClientOptions = {}) {}

  async start(): Promise<InitializeResponse> {
    if (this.process) {
      throw new AppServerError("App Server is already started");
    }

    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    this.process = spawn(command, args, {
      cwd: this.options.cwd,
      env: safeEnvironment(this.options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.failAll(
        new AppServerError(
          `App Server exited (${signal ?? String(code)})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    this.process.on("error", (error) => this.failAll(new AppServerError(error.message)));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
    });

    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    const params: InitializeParams = {
      clientInfo: {
        name: "safechange",
        title: "SafeChange",
        version: VERSION,
      },
      capabilities: null,
    };
    const initialized = await this.request<InitializeResponse>("initialize", params);
    this.notify("initialized", {});
    return initialized;
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request("thread/start", params);
  }

  forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> {
    return this.request("thread/fork", params);
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params);
  }

  async runTurn(threadId: string, prompt: string, options: RunTurnOptions): Promise<TurnResult> {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: options.cwd,
      approvalPolicy: "never",
      sandboxPolicy: options.sandboxPolicy,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema as JsonValue } : {}),
    };
    const started = await this.request<TurnStartResponse>("turn/start", params);
    const turnId = started.turn.id;

    let completion: TurnCompletedNotification;
    try {
      completion = await this.waitForTurn(
        turnId,
        options.timeoutMs ?? this.options.turnTimeoutMs ?? 300_000,
      );
    } catch (error) {
      const interrupt: TurnInterruptParams = { threadId, turnId };
      await this.request("turn/interrupt", interrupt).catch(() => undefined);
      throw error;
    }

    if (completion.turn.status !== "completed") {
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

    return {
      threadId,
      turnId,
      status: completion.turn.status,
      message,
    };
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;

    this.lines?.close();
    this.process = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;

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
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 10_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`App Server request ${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
    let message: RpcResponse | RpcNotification;
    try {
      message = JSON.parse(line) as RpcResponse | RpcNotification;
    } catch {
      this.failAll(new AppServerError(`Invalid App Server JSON: ${line.slice(0, 200)}`));
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new AppServerError(message.error.message, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.handleNotification(message);
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === "item/completed") {
      const params = notification.params as ItemCompletedNotification;
      if (params.item.type === "agentMessage") {
        this.agentMessages.set(params.turnId, params.item.text);
      }
      return;
    }

    if (notification.method !== "turn/completed") return;
    const params = notification.params as TurnCompletedNotification;
    const waiter = this.turnWaiters.get(params.turn.id);
    if (waiter) {
      this.turnWaiters.delete(params.turn.id);
      waiter.resolve(params);
    } else {
      this.completedTurns.set(params.turn.id, params);
    }
  }

  private waitForTurn(turnId: string, timeoutMs: number): Promise<TurnCompletedNotification> {
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
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
  }
}
