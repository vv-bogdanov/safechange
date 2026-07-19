import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ChangeSafelyError } from "./errors.js";
import { REPOSITORY_CONTROL_FILE_NAMES } from "./repository-policy.js";
import { hashRecordsEqual } from "./verification.js";

const execFileAsync = promisify(execFile);

export interface BaselineSnapshot {
  repoPath: string;
  branch: string;
  commit: string;
  trackedStatus: string;
  files: Record<string, string>;
  controlFiles: string[];
  protectedConfiguration: Record<string, string>;
  fingerprint: string;
}

export class PreflightError extends ChangeSafelyError {
  constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
    super(reasonCode, message, {
      exitCode: 2,
      nextAction: "Resolve the repository preflight condition and retry.",
    });
    this.name = "PreflightError";
  }
}

export interface RepositoryLock {
  release(): Promise<void>;
}

export function canonicalRepositoryPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PreflightError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed: ${detail}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function inspectProtectedConfiguration(repoPath: string): Promise<Record<string, string>> {
  const protectedConfiguration: Record<string, string> = {};
  for (const path of [".env", ".env.local", ".npmrc"]) {
    const absolutePath = join(repoPath, path);
    if (await pathExists(absolutePath)) {
      const metadata = await stat(absolutePath);
      protectedConfiguration[path] = sha256(
        `${metadata.size}:${metadata.mtimeMs}:${metadata.mode}`,
      );
    }
  }
  return protectedConfiguration;
}

export async function assertProtectedConfigurationUnchanged(
  repoPath: string,
  expected: Record<string, string>,
): Promise<void> {
  const actual = await inspectProtectedConfiguration(repoPath);
  if (!hashRecordsEqual(expected, actual)) {
    throw new PreflightError(
      "PROTECTED_CONFIGURATION_CHANGED",
      "Protected configuration metadata changed during the ChangeSafely run",
    );
  }
}

export async function inspectBaseline(
  repoPath: string,
  capabilityControlFiles?: string[],
): Promise<BaselineSnapshot> {
  const root = await canonicalRepositoryPath(await git(repoPath, ["rev-parse", "--show-toplevel"]));
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["branch", "--show-current"]);
  if (!branch) {
    throw new PreflightError("DETACHED_HEAD", "ChangeSafely requires a named current branch");
  }

  const trackedStatus = await git(root, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (trackedStatus) {
    throw new PreflightError(
      "DIRTY_TRACKED_STATE",
      "Tracked or staged changes must be committed before ChangeSafely planning",
    );
  }

  const operationMarkers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
  ];
  for (const marker of operationMarkers) {
    const markerPath = await git(root, ["rev-parse", "--git-path", marker]);
    if (await pathExists(markerPath)) {
      throw new PreflightError(
        "GIT_OPERATION_IN_PROGRESS",
        `Git operation marker is present: ${marker}`,
      );
    }
  }

  const trackedFiles = (await git(root, ["ls-files"])).split("\n").filter(Boolean);
  const catalogControls = new Set(capabilityControlFiles ?? []);
  const relevant = trackedFiles.filter(
    (path) =>
      catalogControls.has(path) ||
      (!capabilityControlFiles && REPOSITORY_CONTROL_FILE_NAMES.has(basename(path))) ||
      basename(path) === "AGENTS.md",
  );
  const files: Record<string, string> = {};
  for (const path of relevant.sort()) {
    files[path] = sha256(await readFile(join(root, path)));
  }

  const protectedConfiguration = await inspectProtectedConfiguration(root);

  const fingerprint = sha256(
    JSON.stringify({
      commit,
      branch,
      trackedStatus,
      files: Object.entries(files),
      protectedConfiguration: Object.entries(protectedConfiguration),
    }),
  );
  return {
    repoPath: root,
    branch,
    commit,
    trackedStatus,
    files,
    controlFiles: relevant.sort(),
    protectedConfiguration,
    fingerprint,
  };
}

export async function assertBaselineUnchanged(
  expected: BaselineSnapshot,
): Promise<BaselineSnapshot> {
  const actual = await inspectBaseline(expected.repoPath, expected.controlFiles);
  if (actual.fingerprint !== expected.fingerprint) {
    throw new PreflightError(
      "BASELINE_CHANGED",
      `Baseline changed from ${expected.fingerprint} to ${actual.fingerprint}`,
    );
  }
  return actual;
}

async function untrackedPaths(repoPath: string): Promise<string[]> {
  const output = await git(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  return output
    .split("\n")
    .filter((path) => path && !path.startsWith(".changesafely/"))
    .sort();
}

export async function assertNoUntrackedFiles(repoPath: string): Promise<void> {
  const paths = await untrackedPaths(repoPath);
  if (paths.length > 0) {
    throw new PreflightError(
      "UNTRACKED_FILES_PRESENT",
      `Non-ignored untracked files must be moved or committed before a write phase: ${paths.join(", ")}`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function acquireRepositoryLock(
  repoPath: string,
  runId: string,
): Promise<RepositoryLock> {
  const lockPath = resolve(
    repoPath,
    await git(repoPath, ["rev-parse", "--git-path", "changesafely.lock"]),
  );
  const token = randomUUID();
  const content = `${JSON.stringify({ pid: process.pid, runId, token, createdAt: new Date().toISOString() })}\n`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
      } catch (error) {
        await unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
            if (current.token === token) await unlink(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: unknown; runId?: unknown } = {};
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8")) as typeof owner;
      } catch {
        const metadata = await stat(lockPath).catch(() => undefined);
        if (metadata && Date.now() - metadata.mtimeMs < 60_000) {
          throw new PreflightError(
            "REPOSITORY_LOCKED",
            "Repository has a recently created ChangeSafely writer lock",
          );
        }
      }
      if (typeof owner.pid === "number" && processIsAlive(owner.pid)) {
        throw new PreflightError(
          "REPOSITORY_LOCKED",
          `Repository is already being written by ChangeSafely run ${String(owner.runId ?? "unknown")} (PID ${owner.pid})`,
        );
      }
      await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new PreflightError(
    "REPOSITORY_LOCKED",
    "Could not acquire the ChangeSafely repository lock",
  );
}

export async function createChangeSafelyBranch(
  baseline: BaselineSnapshot,
  runId: string,
): Promise<string> {
  await assertBaselineUnchanged(baseline);
  await assertNoUntrackedFiles(baseline.repoPath);
  const branch = `changesafely/${runId}`;
  await git(baseline.repoPath, ["switch", "-c", branch, baseline.commit]);
  return branch;
}

export async function changedPaths(repoPath: string, from = "HEAD"): Promise<string[]> {
  const tracked = await git(repoPath, ["diff", "--name-only", from, "--"]);
  const untracked = await git(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  return [
    ...new Set(
      `${tracked}\n${untracked}`
        .split("\n")
        .filter((path) => path && !path.startsWith(".changesafely/")),
    ),
  ].sort();
}

export async function diffFrom(repoPath: string, from: string): Promise<string> {
  return git(repoPath, ["diff", "--no-ext-diff", from, "--"]);
}

export async function commitPaths(
  repoPath: string,
  paths: string[],
  message: string,
): Promise<string> {
  if (paths.length === 0) {
    throw new PreflightError("NO_CHANGES", "No paths are available to commit");
  }
  await git(repoPath, ["add", "--", ...paths]);
  await git(repoPath, ["commit", "-m", message, "--", ...paths]);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

export async function hashFiles(
  repoPath: string,
  paths: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    result[path] = sha256(await readFile(join(repoPath, path)));
  }
  return result;
}

export async function currentCommit(repoPath: string): Promise<string> {
  return git(repoPath, ["rev-parse", "HEAD"]);
}

export async function currentBranch(repoPath: string): Promise<string> {
  return git(repoPath, ["branch", "--show-current"]);
}

export async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoPath,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
