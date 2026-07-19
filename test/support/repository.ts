import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { RunState } from "../../src/artifacts.js";

const execFileAsync = promisify(execFile);

export interface TestRepositoryOptions {
  prefix?: string;
  files: Record<string, string>;
  commitMessage?: string;
}

export async function createTestRepo(
  t: TestContext,
  options: TestRepositoryOptions,
): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), options.prefix ?? "safechange-test-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(options.files)) {
    const absolutePath = join(repoPath, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.name", "SafeChange Test"]);
  await git(repoPath, ["config", "user.email", "test@safechange.local"]);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", options.commitMessage ?? "fixture baseline"]);
  return repoPath;
}

export async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout.trim();
}

export async function readRunState(runPath: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runPath, "state.json"), "utf8")) as RunState;
}
