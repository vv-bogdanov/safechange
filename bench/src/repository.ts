import { execFile } from "node:child_process";
import { cp, lstat, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ScenarioDefinition {
  id: string;
  version: number;
  root: string;
  baseline: string;
  task: string;
  evaluator: string;
}

export interface MaterializedAttempt {
  workspace: string;
  baselineCommit: string;
}

export interface AttemptSnapshot {
  baselineCommit: string;
  snapshotCommit: string;
  diff: string;
  changedFiles: string[];
}

const scenarioVersions: Readonly<Record<string, number>> = {
  "double-charge": 2,
  "restart-storm": 2,
  "tenant-leak": 2,
};

export function scenarioDefinition(
  benchRoot: string,
  scenario: string,
  expectedVersion?: number,
): ScenarioDefinition {
  const version = scenarioVersions[scenario];
  if (!version) {
    throw new Error(`Unknown benchmark scenario: ${scenario}`);
  }
  if (expectedVersion !== undefined && expectedVersion !== version) {
    throw new Error(
      `Benchmark scenario ${scenario} v${expectedVersion} is unavailable; current assets are v${version}`,
    );
  }
  const root = resolve(benchRoot, "scenarios", scenario);
  return {
    id: scenario,
    version,
    root,
    baseline: join(root, "baseline"),
    task: join(root, "task.txt"),
    evaluator: resolve(benchRoot, "oracles", scenario, "evaluate.mjs"),
  };
}

export async function materializeAttempt(
  scenario: ScenarioDefinition,
  destination: string,
  options: { installDependencies?: boolean } = {},
): Promise<MaterializedAttempt> {
  await assertMissing(destination);
  await mkdir(destination, { mode: 0o700 });
  await cp(scenario.baseline, destination, {
    recursive: true,
    filter: (source) => !["dist", "node_modules"].includes(basename(source)),
  });
  await repositoryCommand("git", ["init", "--quiet", "-b", "benchmark"], destination);
  await repositoryCommand("git", ["config", "user.name", "ChangeSafely Benchmark"], destination);
  await repositoryCommand(
    "git",
    ["config", "user.email", "benchmark@changesafely.local"],
    destination,
  );
  await repositoryCommand("git", ["add", "."], destination);
  await repositoryCommand("git", ["commit", "--quiet", "-m", "benchmark baseline"], destination);
  if (options.installDependencies ?? true) {
    await repositoryCommand(
      "npm",
      ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
      destination,
      120_000,
    );
  }
  const baselineCommit = await repositoryCommand("git", ["rev-parse", "HEAD"], destination);
  const remotes = await repositoryCommand("git", ["remote"], destination);
  if (remotes) throw new Error("Disposable benchmark repository unexpectedly has a remote");
  return { workspace: destination, baselineCommit };
}

export async function snapshotAttempt(
  workspace: string,
  baselineCommit: string,
): Promise<AttemptSnapshot> {
  const root = resolve(await repositoryCommand("git", ["rev-parse", "--show-toplevel"], workspace));
  if (root !== resolve(workspace)) throw new Error("Benchmark workspace Git root changed");
  await repositoryCommand("git", ["cat-file", "-e", `${baselineCommit}^{commit}`], workspace);
  await repositoryCommand(
    "git",
    ["merge-base", "--is-ancestor", baselineCommit, "HEAD"],
    workspace,
  );
  await repositoryCommand("git", ["add", "-A"], workspace);
  await repositoryCommand(
    "git",
    ["commit", "--quiet", "--allow-empty", "-m", "benchmark attempt snapshot"],
    workspace,
  );
  const snapshotCommit = await repositoryCommand("git", ["rev-parse", "HEAD"], workspace);
  const diff = await repositoryCommand(
    "git",
    ["diff", "--binary", "--no-ext-diff", baselineCommit, snapshotCommit],
    workspace,
    30_000,
    false,
  );
  const changed = await repositoryCommand(
    "git",
    ["diff", "--name-only", "-z", baselineCommit, snapshotCommit],
    workspace,
    30_000,
    false,
  );
  return {
    baselineCommit,
    snapshotCommit,
    diff,
    changedFiles: changed.split("\0").filter(Boolean),
  };
}

export async function repositoryCommand(
  program: string,
  args: string[],
  cwd: string,
  timeout = 30_000,
  trim = true,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(program, args, {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        NO_UPDATE_NOTIFIER: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_offline: "true",
      },
    });
    return trim ? stdout.trim() : stdout;
  } catch (error) {
    throw new Error(
      `${program} ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`Benchmark workspace already exists: ${path}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
