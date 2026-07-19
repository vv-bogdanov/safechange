import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "../../src/version.js";
import {
  COMPARISON_VERSION,
  type ComparisonManifest,
  validateComparisonManifest,
} from "./contracts.js";
import { contentSha256 } from "./evidence.js";

const execFileAsync = promisify(execFile);

export type ComparisonInput = Omit<
  ComparisonManifest,
  "comparisonId" | "comparisonVersion" | "createdAt" | "scenarioVersion"
> & { scenarioVersion: number };

export interface StoredComparison {
  path: string;
  sha256: string;
  manifest: ComparisonManifest;
}

export async function ensureComparisonManifest(
  resultsRoot: string,
  input: ComparisonInput,
): Promise<StoredComparison> {
  if (contentSha256(input.taskText) !== input.taskSha256) {
    throw new Error("Comparison task hash mismatch");
  }
  const comparisonId = `comparison-${contentSha256(JSON.stringify(input)).slice(0, 16)}`;
  const path = join(resultsRoot, "comparisons", `${comparisonId}.json`);
  let content: string;
  try {
    content = await readFile(path, "utf8");
    const manifest = validateComparisonManifest(parseJson(content));
    if (JSON.stringify(comparisonContract(manifest)) !== JSON.stringify(input)) {
      throw new Error(`Comparison manifest contract mismatch: ${comparisonId}`);
    }
    return { path, sha256: contentSha256(content), manifest };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const manifest = validateComparisonManifest({
    comparisonVersion: COMPARISON_VERSION,
    comparisonId,
    createdAt: new Date().toISOString(),
    ...input,
  });
  content = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return await ensureComparisonManifest(resultsRoot, input);
    throw error;
  }
  return { path, sha256: contentSha256(content), manifest };
}

export async function collectEnvironmentVersions(
  codexCommand = "codex",
  projectRoot = process.cwd(),
) {
  const [gitVersion, codexVersion, changesafelyCommit] = await Promise.all([
    commandVersion("git"),
    commandVersion(codexCommand),
    commandOutput("git", ["-C", projectRoot, "rev-parse", "HEAD"]),
  ]);
  return {
    nodeVersion: process.version,
    gitVersion,
    codexVersion,
    changesafelyVersion: VERSION,
    changesafelyCommit,
    platform: platform(),
    architecture: arch(),
  };
}

export async function resolveCodexCommand(projectRoot: string): Promise<string> {
  const localBin = resolve(projectRoot, "node_modules", ".bin");
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || resolve(directory) === localBin) continue;
    const candidate = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error("Cannot find a standard Codex executable outside project node_modules");
}

function comparisonContract(manifest: ComparisonManifest): ComparisonInput {
  const {
    comparisonVersion: _version,
    comparisonId: _id,
    createdAt: _createdAt,
    ...input
  } = manifest;
  if (input.scenarioVersion === undefined) {
    throw new Error("New comparison manifests require an explicit scenario version");
  }
  return input as ComparisonInput;
}

async function commandVersion(command: string): Promise<string> {
  return await commandOutput(command, ["--version"]);
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 3_000,
      maxBuffer: 16 * 1024,
    });
    const value = stdout.trim();
    if (!value) throw new Error(`${command} returned empty output`);
    return value.slice(0, 500);
  } catch (error) {
    throw new Error(
      `Cannot record ${command}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Invalid comparison manifest JSON");
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
