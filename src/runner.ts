import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import spawn from "cross-spawn";
import { repositoryCommandEnvironment } from "./environment.js";
import { errorReasonCode } from "./errors.js";
import { OutputCapture } from "./output-capture.js";
import type { CommandEvidence } from "./schemas.js";
import type { TraceWriter } from "./trace.js";

export type { CommandEvidence } from "./schemas.js";

export interface CommandResult {
  commandId: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sandboxed: boolean;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  sandboxed?: boolean;
  permissionProfile?: string;
  signal?: AbortSignal;
  trace?: TraceWriter;
  phase?: string;
}

const forbiddenTokens = new Set(["|", "||", "&&", ";", ">", ">>", "<"]);
const CAPTURE_SCRIPT = `const { closeSync, fstatSync, openSync, writeSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [capturePath, maxText, program, ...args] = process.argv.slice(1);
const maxBytes = Number(maxText);
const hardLimit = Math.max(maxBytes * 4, 1024 * 1024);
const stdoutPath = capturePath + ".stdout";
const stderrPath = capturePath + ".stderr";
const stdoutFd = openSync(stdoutPath, "wx", 0o600);
const stderrFd = openSync(stderrPath, "wx", 0o600);
const child = spawn(program, args, {
  detached: process.platform !== "win32",
  env: process.env,
  stdio: ["ignore", stdoutFd, stderrFd],
});
let overflow = false;
const limitTimer = setInterval(() => {
  if (fstatSync(stdoutFd).size <= hardLimit && fstatSync(stderrFd).size <= hardLimit) return;
  overflow = true;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}, 25);
child.on("error", (error) => writeSync(stderrFd, Buffer.from(error.message)));
child.on("close", (exitCode, signal) => {
  clearInterval(limitTimer);
  closeSync(stdoutFd); closeSync(stderrFd);
  const result = overflow ? { exitCode: 1, signal: null } : { exitCode, signal };
  if (result.signal) process.kill(process.pid, result.signal); else process.exit(result.exitCode ?? 1);
});`;

function acceptsForwardedArgs(args: string[], commandLength: number): boolean {
  return (
    args.length === commandLength ||
    (args.length > commandLength + 1 && args[commandLength] === "--")
  );
}

function isNpmScript(name: string | undefined, bases: string[]): boolean {
  return bases.some((base) => name === base || name?.startsWith(`${base}:`));
}

function isTestCommand(argv: string[]): boolean {
  const [program, ...args] = argv;
  return (
    (program === "npm" &&
      ((args[0] === "test" && acceptsForwardedArgs(args, 1)) ||
        (args[0] === "run" && isNpmScript(args[1], ["test"]) && acceptsForwardedArgs(args, 2)))) ||
    (program === "node" && args[0] === "--test")
  );
}

export function isSafetyTestCommand(argv: string[]): boolean {
  const [program, ...args] = argv;
  return (
    program === "npm" &&
    ((args[0] === "test" && acceptsForwardedArgs(args, 1)) ||
      (args[0] === "run" && isNpmScript(args[1], ["test"]) && acceptsForwardedArgs(args, 2)))
  );
}

export function validateCommandArgv(argv: string[]): void {
  const [program, ...args] = argv;
  if (!program) throw new Error("Command argv must not be empty");
  if (argv.some((part) => forbiddenTokens.has(part))) {
    throw new Error(`Shell operators are forbidden in command argv: ${argv.join(" ")}`);
  }
  if (program === "npm") {
    const allowed =
      isTestCommand(argv) ||
      (args[0] === "run" &&
        isNpmScript(args[1], ["typecheck", "lint", "check", "build"]) &&
        acceptsForwardedArgs(args, 2));
    if (!allowed) throw new Error(`npm command is not approved: ${argv.join(" ")}`);
    return;
  }
  if (program === "node" && args[0] === "--test") return;
  throw new Error(`Executable is not approved for MVP verification: ${program}`);
}

function commandName(argv: string[]): string {
  if (argv[0] === "node") return "node --test";
  return argv.slice(0, 3).join(" ");
}

function relativeCwd(repoPath: string, cwd: string): string {
  const value = relative(repoPath, cwd);
  if (value === "") return ".";
  if (value === ".." || value.startsWith(`..${sep}`)) return "<outside-repository>";
  return value.split(sep).join("/");
}

export function toCommandEvidence(results: CommandResult[], repoPath: string): CommandEvidence[] {
  return results.map((result) => ({
    commandId: result.commandId,
    command: commandName(result.argv),
    argv: result.argv,
    cwd: relativeCwd(repoPath, result.cwd),
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    sandboxed: result.sandboxed,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutSha256: result.stdoutSha256,
    stderrSha256: result.stderrSha256,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }));
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function runCommand(
  argv: string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  validateCommandArgv(argv);
  const directProgram = argv[0];
  if (!directProgram) throw new Error("Command argv must not be empty");
  const startedAt = new Date();
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  let timedOut = false;
  const sandboxed = options.sandboxed ?? false;
  const program = sandboxed ? "codex" : directProgram;
  const permissionProfile = options.permissionProfile ?? ":workspace";
  const sourceEnvironment = options.env ?? process.env;
  const commandId = randomUUID();
  const capturePath =
    sandboxed && options.permissionProfile
      ? join(cwd, ".changesafely", "command-results", `${commandId}.json`)
      : undefined;
  if (capturePath) await mkdir(dirname(capturePath), { recursive: true, mode: 0o700 });
  const capturedCommand = capturePath
    ? await resolveCapturedCommand(argv, sourceEnvironment)
    : argv;
  const sandboxCommand = capturePath
    ? [
        process.execPath,
        "-e",
        CAPTURE_SCRIPT,
        capturePath,
        String(maxOutputBytes),
        ...capturedCommand,
      ]
    : argv;
  const args = sandboxed
    ? [
        "sandbox",
        "-P",
        permissionProfile,
        ...(options.permissionProfile ? [] : ["--sandbox-state-disable-network"]),
        "-C",
        cwd,
        "--",
        ...sandboxCommand,
      ]
    : argv.slice(1);
  const namedCodexHome = options.permissionProfile
    ? (sourceEnvironment.CODEX_HOME ?? join(sourceEnvironment.HOME ?? homedir(), ".codex"))
    : undefined;

  const commandHome = await mkdtemp(join(homedir(), ".changesafely-command-"));
  const commandEnvironment = repositoryCommandEnvironment(commandHome, options.env);
  if (namedCodexHome && options.permissionProfile) commandEnvironment.CODEX_HOME = namedCodexHome;
  const stdout = new OutputCapture(maxOutputBytes);
  const stderr = new OutputCapture(maxOutputBytes);

  await options.trace?.append({
    component: "command",
    event: "command.executed",
    status: "started",
    ...(options.phase ? { phase: options.phase } : {}),
    commandId,
    argv,
    cwd: options.trace.relativeCwd(cwd),
    startedAt: startedAt.toISOString(),
    sandboxed,
  });

  try {
    const child = spawn(program, args, {
      cwd,
      env: commandEnvironment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    const timeoutMs = options.timeoutMs ?? 120_000;
    let childResult: { exitCode: number | null; signal: NodeJS.Signals | null };
    try {
      childResult = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          let forceTimer: NodeJS.Timeout | undefined;
          let terminating = false;
          const abort = () => {
            if (terminating) return;
            terminating = true;
            killProcessTree(child, "SIGTERM");
            forceTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
          };
          const timer = setTimeout(() => {
            timedOut = true;
            abort();
          }, timeoutMs);
          const onAbort = () => abort();
          options.signal?.addEventListener("abort", onAbort, { once: true });
          child.on("error", (error) => {
            clearTimeout(timer);
            if (forceTimer) clearTimeout(forceTimer);
            options.signal?.removeEventListener("abort", onAbort);
            reject(error);
          });
          child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            if (forceTimer) clearTimeout(forceTimer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve({ exitCode, signal });
          });
          if (options.signal?.aborted) onAbort();
        },
      );
    } catch (error) {
      if (sandboxed) {
        throw new Error(
          `Sandbox execution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
    const completedAt = new Date();
    const captured =
      capturePath && !timedOut && childResult.exitCode !== null
        ? await loadCapturedOutput(capturePath, maxOutputBytes)
        : undefined;
    const stdoutSnapshot = captured?.stdout ?? stdout.snapshot();
    const stderrSnapshot = captured?.stderr ?? stderr.snapshot();
    const diagnosticsPaths = (
      await Promise.all([
        options.trace?.writeDiagnostic(`${commandId}.stdout.log`, stdoutSnapshot.tail),
        options.trace?.writeDiagnostic(`${commandId}.stderr.log`, stderrSnapshot.tail),
      ])
    ).filter((path): path is string => Boolean(path));
    const result: CommandResult = {
      commandId,
      argv,
      cwd,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      exitCode: childResult.exitCode,
      signal: childResult.signal,
      timedOut,
      stdout: stdoutSnapshot.tail,
      stderr: stderrSnapshot.tail,
      stdoutBytes: stdoutSnapshot.bytes,
      stderrBytes: stderrSnapshot.bytes,
      stdoutSha256: stdoutSnapshot.sha256,
      stderrSha256: stderrSnapshot.sha256,
      stdoutTruncated: stdoutSnapshot.truncated,
      stderrTruncated: stderrSnapshot.truncated,
      sandboxed,
    };
    const passed = result.exitCode === 0 && !result.timedOut;
    await options.trace?.append({
      component: "command",
      event: "command.executed",
      status: passed ? "completed" : "failed",
      ...(options.phase ? { phase: options.phase } : {}),
      commandId,
      argv,
      cwd: options.trace.relativeCwd(cwd),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      sandboxed: result.sandboxed,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      ...(diagnosticsPaths.length > 0 ? { diagnosticsPaths } : {}),
      ...(!passed
        ? {
            reasonCode: result.timedOut
              ? "COMMAND_TIMEOUT"
              : options.signal?.aborted
                ? errorReasonCode(options.signal.reason)
                : "COMMAND_FAILED",
          }
        : {}),
    });
    return result;
  } catch (error) {
    await options.trace?.recordFailure("command", "command.executed", error, {
      ...(options.phase ? { phase: options.phase } : {}),
      commandId,
      argv,
      cwd: options.trace.relativeCwd(cwd),
      startedAt: startedAt.toISOString(),
      sandboxed,
    });
    throw error;
  } finally {
    if (capturePath) {
      await Promise.all([
        rm(capturePath, { force: true }),
        rm(`${capturePath}.stdout`, { force: true }),
        rm(`${capturePath}.stderr`, { force: true }),
      ]);
    }
    await rm(commandHome, { recursive: true, force: true });
  }
}

async function resolveCapturedCommand(
  argv: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  if (argv[0] === "node") return [process.execPath, ...argv.slice(1)];
  const runtimeNpm = join(
    dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  const npmPath = (await accessible(runtimeNpm))
    ? runtimeNpm
    : (environment.npm_execpath ?? (await resolveExecutable("npm", environment.PATH)));
  const executable = await realpath(npmPath);
  return executable.endsWith(".js")
    ? [process.execPath, executable, ...argv.slice(1)]
    : [executable, ...argv.slice(1)];
}

async function accessible(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(name: string, pathValue = ""): Promise<string> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error(`Cannot resolve approved executable: ${name}`);
}

interface CapturedOutput {
  stdout: ReturnType<OutputCapture["snapshot"]>;
  stderr: ReturnType<OutputCapture["snapshot"]>;
}

async function loadCapturedOutput(
  capturePath: string,
  maxOutputBytes: number,
): Promise<CapturedOutput> {
  const [stdout, stderr] = await Promise.all([
    captureFile(`${capturePath}.stdout`, maxOutputBytes),
    captureFile(`${capturePath}.stderr`, maxOutputBytes),
  ]);
  return { stdout, stderr };
}

async function captureFile(path: string, maxOutputBytes: number) {
  const output = new OutputCapture(maxOutputBytes);
  await new Promise<void>((resolveCapture, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => output.append(chunk));
    stream.once("error", reject);
    stream.once("end", resolveCapture);
  });
  return output.snapshot();
}
