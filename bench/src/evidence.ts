import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  EVIDENCE_VERSION,
  type EvidenceManifest,
  type RunDocument,
  validateComparisonManifest,
  validateEvidenceManifest,
  validateRunDocument,
} from "./contracts.js";

const MANIFEST_FILE = "evidence-manifest.json";
const RUN_FILE = "run.json";

export interface VerifiedEvidence {
  path: string;
  run: RunDocument;
  manifest: EvidenceManifest;
  manifestSha256: string;
}

export async function createEvidencePackage(
  resultsRoot: string,
  runInput: RunDocument,
  files: Readonly<Record<string, string | Buffer>>,
): Promise<VerifiedEvidence> {
  const run = validateRunDocument(runInput);
  verifyRunLineage(run);
  if (MANIFEST_FILE in files || RUN_FILE in files) {
    throw new Error(`${MANIFEST_FILE} and ${RUN_FILE} are controller-owned`);
  }

  const contentByPath = new Map<string, Buffer>();
  contentByPath.set(RUN_FILE, Buffer.from(`${JSON.stringify(run, null, 2)}\n`));
  for (const [path, content] of Object.entries(files)) {
    validateEvidencePath(path);
    contentByPath.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  for (const required of ["comparison.json", "diff.patch", "events.jsonl"]) {
    if (!contentByPath.has(required))
      throw new Error(`Missing required evidence file: ${required}`);
  }
  verifyComparisonLineage(run, contentByPath.get("comparison.json") ?? Buffer.alloc(0));

  const manifest: EvidenceManifest = {
    evidenceVersion: EVIDENCE_VERSION,
    runId: run.runId,
    files: [...contentByPath]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({ path, bytes: content.byteLength, sha256: sha256(content) })),
  };
  validateEvidenceManifest(manifest);

  await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
  const packagePath = resolveWithin(resultsRoot, run.runId);
  try {
    await mkdir(packagePath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`Benchmark evidence already exists: ${run.runId}`);
    }
    throw error;
  }

  for (const [path, content] of contentByPath) {
    const target = resolveWithin(packagePath, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
  }
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolveWithin(packagePath, MANIFEST_FILE), manifestContent, {
    flag: "wx",
    mode: 0o600,
  });

  return { path: packagePath, run, manifest, manifestSha256: sha256(manifestContent) };
}

export async function loadEvidencePackage(
  resultsRoot: string,
  runId: string,
): Promise<VerifiedEvidence> {
  validateRunId(runId);
  const packagePath = resolveWithin(resultsRoot, runId);
  const manifestContent = await readFile(resolveWithin(packagePath, MANIFEST_FILE), "utf8");
  const manifest = validateEvidenceManifest(parseJson(manifestContent, MANIFEST_FILE));
  if (manifest.runId !== runId) throw new Error("Evidence manifest run identity mismatch");

  const expectedPaths = [...manifest.files.map((file) => file.path), MANIFEST_FILE].sort();
  const actualPaths = (await listFiles(packagePath)).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Evidence package file set does not match its manifest");
  }

  for (const file of manifest.files) {
    validateEvidencePath(file.path);
    const content = await readFile(resolveWithin(packagePath, file.path));
    if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw new Error(`Evidence hash mismatch: ${file.path}`);
    }
  }

  const run = validateRunDocument(
    parseJson(await readFile(resolveWithin(packagePath, RUN_FILE), "utf8"), RUN_FILE),
  );
  if (run.runId !== runId) throw new Error("Benchmark run identity mismatch");
  verifyRunLineage(run);
  verifyComparisonLineage(run, await readFile(resolveWithin(packagePath, "comparison.json")));
  return { path: packagePath, run, manifest, manifestSha256: sha256(manifestContent) };
}

export async function listEvidencePackages(resultsRoot: string): Promise<VerifiedEvidence[]> {
  const entries = await readdir(resultsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  const packages: VerifiedEvidence[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || ["analyses", "comparisons"].includes(entry.name)) continue;
    packages.push(await loadEvidencePackage(resultsRoot, entry.name));
  }
  return packages;
}

export async function readVerifiedEvidenceFile(
  evidence: VerifiedEvidence,
  relativePath: string,
): Promise<Buffer> {
  const entry = evidence.manifest.files.find((file) => file.path === relativePath);
  if (!entry) throw new Error(`Evidence file is not in the manifest: ${relativePath}`);
  const content = await readFile(resolveWithin(evidence.path, relativePath));
  if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) {
    throw new Error(`Evidence hash mismatch: ${relativePath}`);
  }
  return content;
}

export function contentSha256(value: string | Buffer): string {
  return sha256(value);
}

function verifyRunLineage(run: RunDocument): void {
  if (sha256(run.taskText) !== run.taskSha256) {
    throw new Error("Benchmark task hash mismatch");
  }
}

function verifyComparisonLineage(run: RunDocument, content: Buffer): void {
  if (sha256(content) !== run.comparisonSha256) {
    throw new Error("Benchmark comparison hash mismatch");
  }
  const comparison = validateComparisonManifest(
    parseJson(content.toString("utf8"), "comparison.json"),
  );
  if (
    comparison.comparisonId !== run.comparisonId ||
    (comparison.measurement ?? "development") !== (run.measurement ?? "development") ||
    comparison.scenario !== run.scenario ||
    comparison.taskText !== run.taskText ||
    comparison.taskSha256 !== run.taskSha256 ||
    comparison.baselineCommit !== run.baselineCommit ||
    comparison.model !== run.model ||
    comparison.effort !== run.effort ||
    JSON.stringify(comparison.environment) !== JSON.stringify(run.environment)
  ) {
    throw new Error("Benchmark comparison lineage mismatch");
  }
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new Error(`Invalid benchmark run id: ${runId}`);
  }
}

function validateEvidencePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid evidence path: ${path}`);
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes benchmark evidence root: ${relativePath}`);
  }
  return path;
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolveWithin(root, relative || "."), {
    withFileTypes: true,
  })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are forbidden in evidence: ${path}`);
    if (entry.isDirectory()) result.push(...(await listFiles(root, path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unsupported evidence entry: ${path}`);
  }
  return result;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(content: string, description: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${description}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
