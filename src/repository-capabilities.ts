import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { ChangeSafelyError } from "./errors.js";
import { normalizeRepositoryPath, pathWithinPrefixes } from "./repository-policy.js";

const execFileAsync = promisify(execFile);

export type CheckKind = "test" | "typecheck" | "lint" | "build";

export interface RepositoryCheck {
  id: string;
  kind: CheckKind;
  argv: string[];
  cwd: string;
}

export interface RepositoryCapabilities {
  checks: RepositoryCheck[];
  testPathPrefixes: string[];
  testFilePatterns: string[];
  controlFiles: string[];
  sources: string[];
}

const npmControlNames = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
]);

export async function discoverRepositoryCapabilities(
  repoPath: string,
): Promise<RepositoryCapabilities> {
  const trackedFiles = await gitFiles(repoPath);
  const manifests = trackedFiles.filter((path) => posix.basename(path) === "package.json");
  const checks: RepositoryCheck[] = [];
  const testPathPrefixes = new Set<string>();
  const controlFiles = new Set(
    trackedFiles.filter((path) => npmControlNames.has(posix.basename(path))),
  );
  const sources: string[] = [];

  for (const manifest of manifests.sort()) {
    const cwd = dirname(manifest) === "." ? "." : normalizeRepositoryPath(dirname(manifest));
    const scripts = packageScripts(await readFile(`${repoPath}/${manifest}`, "utf8"), manifest);
    sources.push(`npm:${manifest}`);
    for (const [name] of Object.entries(scripts).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const kind = npmCheckKind(name);
      if (!kind) continue;
      checks.push({
        id: `npm:${cwd}:${name}`,
        kind,
        argv: name === "test" ? ["npm", "test"] : ["npm", "run", name],
        cwd,
      });
    }
    for (const directory of ["test", "tests", "spec", "__tests__"]) {
      testPathPrefixes.add(cwd === "." ? directory : `${cwd}/${directory}`);
    }
  }
  if (manifests.length > 0) sources.push(`executable:npm:${await resolveExecutable("npm")}`);

  return normalizeCapabilities({
    checks,
    testPathPrefixes: [...testPathPrefixes],
    testFilePatterns: ["*.test.*", "*.spec.*"],
    controlFiles: [...controlFiles],
    sources,
  });
}

export function capabilitiesSha256(capabilities: RepositoryCapabilities): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeCapabilities(capabilities)))
    .digest("hex");
}

export function authorizeRepositoryCheck(
  capabilities: RepositoryCapabilities,
  argv: string[],
  cwd = ".",
  kind?: CheckKind,
): RepositoryCheck | undefined {
  const normalizedCwd = normalizeRepositoryPath(cwd);
  return capabilities.checks.find(
    (check) =>
      (!kind || check.kind === kind) &&
      check.cwd === normalizedCwd &&
      sameStrings(check.argv, argv),
  );
}

export function requireRepositoryCheck(
  capabilities: RepositoryCapabilities,
  argv: string[],
  cwd = ".",
  kind?: CheckKind,
): RepositoryCheck {
  const check = authorizeRepositoryCheck(capabilities, argv, cwd, kind);
  if (!check) {
    throw new ChangeSafelyError(
      "COMMAND_NOT_IN_CAPABILITY_CATALOG",
      `Command is not in the baseline repository capability catalog: ${cwd}: ${argv.join(" ")}`,
      {
        exitCode: 2,
        nextAction: "Select an exact check listed by ChangeSafely during repository preflight.",
      },
    );
  }
  return check;
}

export function isCapabilityTestPath(capabilities: RepositoryCapabilities, path: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeRepositoryPath(path);
  } catch {
    return false;
  }
  if (pathWithinPrefixes(normalized, capabilities.testPathPrefixes)) return true;
  const name = posix.basename(normalized);
  return capabilities.testFilePatterns.some((pattern) => matchesSimplePattern(name, pattern));
}

export function assertUsableCapabilities(capabilities: RepositoryCapabilities): void {
  if (!capabilities.checks.some((check) => check.kind === "test")) {
    throw new ChangeSafelyError(
      "UNSUPPORTED_REPOSITORY",
      "No deterministic repository test check was detected",
      {
        exitCode: 2,
        nextAction:
          "Add an npm test script or declare repository checks in the ChangeSafely config.",
      },
    );
  }
}

function normalizeCapabilities(capabilities: RepositoryCapabilities): RepositoryCapabilities {
  return {
    checks: [...capabilities.checks]
      .map((check) => ({
        ...check,
        argv: [...check.argv],
        cwd: normalizeRepositoryPath(check.cwd),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    testPathPrefixes: uniqueSorted(capabilities.testPathPrefixes.map(normalizeRepositoryPath)),
    testFilePatterns: uniqueSorted(capabilities.testFilePatterns),
    controlFiles: uniqueSorted(capabilities.controlFiles.map(normalizeRepositoryPath)),
    sources: uniqueSorted(capabilities.sources),
  };
}

function packageScripts(content: string, path: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in tracked npm manifest: ${path}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const scripts = (value as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function npmCheckKind(name: string): CheckKind | undefined {
  const base = name.split(":", 1)[0];
  if (base === "test") return "test";
  if (base === "typecheck") return "typecheck";
  if (base === "lint") return "lint";
  if (base === "build" || base === "check") return "build";
  return undefined;
}

function matchesSimplePattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(name);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function gitFiles(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repoPath,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean).map(normalizeRepositoryPath).sort();
}

async function resolveExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new ChangeSafelyError("RUNTIME_NOT_FOUND", `Cannot resolve required runtime: ${name}`, {
    exitCode: 2,
    nextAction: `Install ${name} or add it to PATH, then retry.`,
  });
}
