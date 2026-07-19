import { posix } from "node:path";

export const REPOSITORY_CONTROL_FILE_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
]);

export function normalizeRepositoryPath(rawPath: string): string {
  if (
    rawPath === "" ||
    rawPath !== rawPath.trim() ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    posix.isAbsolute(rawPath) ||
    /^[A-Za-z]:/.test(rawPath) ||
    rawPath.split("/").includes("..")
  ) {
    throw new Error(`Invalid repository-relative path: ${rawPath}`);
  }
  const normalized = posix.normalize(rawPath.replace(/^(?:\.\/)+/, ""));
  return normalized === "." ? normalized : normalized.replace(/\/$/, "");
}

function safeRepositoryPath(path: string): string | undefined {
  try {
    return normalizeRepositoryPath(path);
  } catch {
    return undefined;
  }
}

export function pathWithinPrefixes(path: string, prefixes: string[]): boolean {
  const candidate = safeRepositoryPath(path);
  if (!candidate) return false;
  return prefixes.some((rawPrefix) => {
    const prefix = safeRepositoryPath(rawPrefix);
    return prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`);
  });
}

export function isTestPath(path: string): boolean {
  const normalized = safeRepositoryPath(path);
  if (!normalized) return false;
  return (
    normalized
      .split("/")
      .some((part) => ["test", "tests", "__tests__", "fixtures"].includes(part)) ||
    /(?:\.test\.|\.spec\.)/.test(normalized)
  );
}

export function isApprovalSensitivePath(path: string, controlFiles?: readonly string[]): boolean {
  const normalized = safeRepositoryPath(path);
  if (!normalized) return true;
  return (
    (controlFiles
      ? controlFiles.includes(normalized) || posix.basename(normalized) === "AGENTS.md"
      : REPOSITORY_CONTROL_FILE_NAMES.has(posix.basename(normalized))) ||
    /(?:^|\/)(?:migrations?|secrets?)(?:\/|$)/i.test(normalized)
  );
}
