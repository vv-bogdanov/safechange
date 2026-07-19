import type { ChildProcess } from "node:child_process";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import spawn from "cross-spawn";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CapturedProcess {
  child: ChildProcess;
  result: Promise<ProcessResult>;
}

function executable(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export function spawnCaptured(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 120_000,
): CapturedProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, CI: "1", NO_COLOR: "1" },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = new Promise<ProcessResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  return { child, result };
}

export async function runSuccessful(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await spawnCaptured(command, args, cwd, env).result;
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export async function installPackedCli(
  projectRoot: string,
  temporaryRoot: string,
): Promise<{ changesafely: string; installRoot: string; setupDemo: string }> {
  const packOutput = await runSuccessful(
    executable("npm"),
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
    projectRoot,
  );
  const filename = (JSON.parse(packOutput) as Array<{ filename?: string }>)[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a tarball filename");

  const installRoot = join(temporaryRoot, "install");
  await runSuccessful(
    executable("npm"),
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporaryRoot, filename),
    ],
    temporaryRoot,
  );
  const binRoot = join(installRoot, "node_modules", ".bin");
  return {
    changesafely: join(binRoot, executable("changesafely")),
    installRoot,
    setupDemo: join(binRoot, executable("changesafely-demo")),
  };
}

export async function createFunctionalRepository(path: string): Promise<void> {
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, ".gitignore"), ".changesafely/\n", "utf8");
  await writeFile(join(path, "AGENTS.md"), "# Package functional fixture\n", "utf8");
  await writeFile(
    join(path, "package.json"),
    `${JSON.stringify(
      {
        name: "changesafely-package-functional-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(path, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await runSuccessful("git", ["init", "-b", "main"], path);
  await runSuccessful("git", ["config", "user.name", "ChangeSafely Package Test"], path);
  await runSuccessful("git", ["config", "user.email", "package-test@changesafely.local"], path);
  await runSuccessful("git", ["add", "."], path);
  await runSuccessful("git", ["commit", "-m", "fixture baseline"], path);
}

export async function createPythonFunctionalRepository(
  path: string,
  fixtureRoot: string,
): Promise<void> {
  await cp(fixtureRoot, path, { recursive: true });
  await runSuccessful("git", ["init", "-b", "main"], path);
  await runSuccessful("git", ["config", "user.name", "ChangeSafely Package Test"], path);
  await runSuccessful("git", ["config", "user.email", "package-test@changesafely.local"], path);
  await runSuccessful("git", ["add", "."], path);
  await runSuccessful("git", ["commit", "-m", "fixture baseline"], path);
}

export async function createFakeCodex(
  root: string,
  codexVersion: string,
  fixture: string,
  mode: string,
): Promise<string> {
  const binRoot = join(root, `fake-bin-${mode}`);
  await mkdir(binRoot, { recursive: true });
  const runner = join(binRoot, "codex-runner.mjs");
  await writeFile(
    runner,
    `import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${codexVersion}\n`)});
  process.exit(0);
}

function run(command, commandArgs, options = {}) {
  const npmCli = ${JSON.stringify(process.env.npm_execpath ?? "")};
  const useNpmCli = process.platform === "win32" && command === "npm" && npmCli;
  const child = spawn(
    useNpmCli ? process.execPath : command,
    useNpmCli ? [npmCli, ...commandArgs] : commandArgs,
    { stdio: "inherit", ...options },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    process.stderr.write(error.message + "\\n");
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (args[0] === "app-server") {
  run(process.execPath, [${JSON.stringify(fixture)}, ${JSON.stringify(mode)}]);
} else if (args[0] === "sandbox") {
  const separator = args.indexOf("--");
  const cwdIndex = args.indexOf("-C");
  const command = args[separator + 1];
  if (separator < 0 || !command) process.exit(2);
  run(command, args.slice(separator + 2), {
    cwd: cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd(),
    env: process.env,
  });
} else {
  process.exit(2);
}
`,
    "utf8",
  );

  const shim = join(binRoot, "codex");
  await writeFile(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} "$@"\n`,
    "utf8",
  );
  await chmod(shim, 0o755);
  await writeFile(`${shim}.cmd`, `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`, "utf8");
  return binRoot;
}

export function cliEnvironment(fakeBin: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` };
}

export async function protocolVersion(projectRoot: string): Promise<string> {
  const value = JSON.parse(
    await readFile(
      join(projectRoot, "src", "app-server", "generated", "protocol-version.json"),
      "utf8",
    ),
  ) as { codexVersion?: string };
  if (!value.codexVersion) throw new Error("Generated Codex protocol version is missing");
  return value.codexVersion;
}
