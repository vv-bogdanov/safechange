import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isTestPath } from "../../src/repository-policy.js";
import { loadAnalysisPackageIfPresent, type VerifiedAnalysis } from "./analysis.js";
import type {
  AnalysisDocument,
  BenchmarkMeasurement,
  BenchmarkMode,
  EvaluationDocument,
} from "./contracts.js";
import { validateEvaluationDocument } from "./contracts.js";
import {
  contentSha256,
  listEvidencePackages,
  loadEvidencePackage,
  readVerifiedEvidenceFile,
  type VerifiedEvidence,
} from "./evidence.js";
import { repositoryCommand } from "./repository.js";

const REPORT_VERSION = 2;
const LIMITATIONS = [
  "This is a custom pilot suite, not universal or statistically significant proof.",
  "Each registered comparison permits one attempt per mode.",
  "Mutation kill rate covers only the scenario's declared mutants.",
  "Unavailable runtime usage remains null and is never estimated.",
] as const;

interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
  testFiles: number;
  testAdditions: number;
  productionFiles: number;
  productionAdditions: number;
}

export interface RunCaseCard {
  runId: string;
  mode: BenchmarkMode;
  outcome: VerifiedEvidence["run"]["outcome"];
  evidenceManifestSha256: string;
  analysisSha256: string;
  safeTaskSuccess: boolean;
  unsafeGreen: boolean;
  scopeDiscipline: boolean | null;
  wallTimeMs: number;
  turns: number | null;
  tokens: VerifiedEvidence["run"]["usage"];
  diff: DiffSummary;
  candidateTests: AnalysisDocument["candidateTests"];
  mutation: AnalysisDocument["mutation"];
  protectedTests: AnalysisDocument["protectedTests"];
}

export interface BenchmarkReport {
  reportVersion: typeof REPORT_VERSION;
  limitations: readonly string[];
  comparisons: Array<{
    comparisonId: string;
    measurement: BenchmarkMeasurement;
    scenario: string;
    model: string;
    effort: string;
    paired: boolean;
    runs: RunCaseCard[];
  }>;
}

export async function replayBenchmarkRun(resultsRoot: string, runId: string) {
  const evidence = await loadEvidencePackage(resultsRoot, runId);
  const analysis = await loadAnalysisPackageIfPresent(resultsRoot, runId, evidence);
  return {
    replayVersion: 1,
    verified: true,
    run: evidence.run,
    manifest: evidence.manifest,
    analysis: analysis?.document ?? null,
    analysisManifest: analysis?.manifest ?? null,
    caseCard: analysis ? await buildRunCaseCard(evidence, analysis) : null,
  } as const;
}

export async function buildBenchmarkReport(resultsRoot: string): Promise<BenchmarkReport> {
  const evidencePackages = await listEvidencePackages(resultsRoot);
  if (evidencePackages.length === 0) throw new Error("No benchmark evidence found");
  const groups = new Map<string, VerifiedEvidence[]>();
  for (const evidence of evidencePackages) {
    const entries = groups.get(evidence.run.comparisonId) ?? [];
    entries.push(evidence);
    groups.set(evidence.run.comparisonId, entries);
  }

  const comparisons: BenchmarkReport["comparisons"] = [];
  for (const [comparisonId, entries] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    entries.sort((left, right) => modeOrder(left.run.mode) - modeOrder(right.run.mode));
    const first = entries[0];
    if (!first) continue;
    const runs = [];
    for (const evidence of entries) {
      const analysis = await loadAnalysisPackageIfPresent(
        resultsRoot,
        evidence.run.runId,
        evidence,
      );
      if (!analysis) {
        throw new Error(
          `Missing analysis for ${evidence.run.runId}; run benchmark evaluate --run ${evidence.run.runId}`,
        );
      }
      runs.push(await buildRunCaseCard(evidence, analysis));
    }
    comparisons.push({
      comparisonId,
      measurement: first.run.measurement ?? "development",
      scenario: first.run.scenario,
      model: first.run.model,
      effort: first.run.effort,
      paired:
        entries.length === 2 &&
        entries.some((entry) => entry.run.mode === "direct") &&
        entries.some((entry) => entry.run.mode === "changesafely"),
      runs,
    });
  }
  return {
    reportVersion: REPORT_VERSION,
    limitations: LIMITATIONS,
    comparisons,
  };
}

export async function writeBenchmarkReport(resultsRoot: string, report: BenchmarkReport) {
  await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdownReport(report);
  const jsonPath = resolve(resultsRoot, "report.json");
  const markdownPath = resolve(resultsRoot, "report.md");
  await Promise.all([
    writeFile(jsonPath, json, { mode: 0o600 }),
    writeFile(markdownPath, markdown, { mode: 0o600 }),
  ]);
  return {
    jsonPath,
    jsonSha256: contentSha256(json),
    markdownPath,
    markdownSha256: contentSha256(markdown),
  };
}

async function buildRunCaseCard(
  evidence: VerifiedEvidence,
  analysis: VerifiedAnalysis,
): Promise<RunCaseCard> {
  const evaluation = await readEvaluation(evidence);
  return {
    runId: evidence.run.runId,
    mode: evidence.run.mode,
    outcome: evidence.run.outcome,
    evidenceManifestSha256: evidence.manifestSha256,
    analysisSha256: analysis.manifest.analysisSha256,
    safeTaskSuccess: evidence.run.outcome === "safe_success",
    unsafeGreen: evidence.run.outcome === "unsafe_green",
    scopeDiscipline: evaluation?.summary.scope ?? null,
    wallTimeMs: evidence.run.worker.durationMs,
    turns: evidence.run.usage.turns,
    tokens: evidence.run.usage,
    diff: await diffSummary(evidence),
    candidateTests: analysis.document.candidateTests,
    mutation: analysis.document.mutation,
    protectedTests: analysis.document.protectedTests,
  };
}

function renderMarkdownReport(report: BenchmarkReport): string {
  const lines = [
    "# ChangeSafely Risk Suite report",
    "",
    "> Custom pilot study; not universal or statistically significant proof.",
    "",
  ];
  for (const comparison of report.comparisons) {
    lines.push(
      `## ${escapeMarkdown(comparison.scenario)} (${comparison.comparisonId})`,
      "",
      `- Measurement: \`${comparison.measurement}\``,
      `- Model: \`${escapeMarkdown(comparison.model)}\``,
      `- Effort: \`${escapeMarkdown(comparison.effort)}\``,
      `- Paired: ${comparison.paired ? "yes" : "no"}`,
      "",
      "| Mode | Outcome | Safe task | Scope | Mutation | Time | Turns | Diff |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const run of comparison.runs) {
      lines.push(
        `| ${run.mode} | ${run.outcome} | ${yesNo(run.safeTaskSuccess)} | ${yesNo(run.scopeDiscipline)} | ${mutationLabel(run)} | ${run.wallTimeMs} ms | ${run.turns ?? "n/a"} | +${run.diff.additions}/-${run.diff.deletions} |`,
      );
    }
    lines.push("");
    for (const run of comparison.runs) {
      lines.push(
        `### ${run.mode}: ${run.runId}`,
        "",
        `- Candidate tests: ${fileCount(run.candidateTests.paths.length)}, +${run.candidateTests.additions}/-${run.candidateTests.deletions}`,
        `- Production diff: ${fileCount(run.diff.productionFiles)}, +${run.diff.productionAdditions}`,
        `- Protected tests: ${run.protectedTests.detail}`,
        `- Evidence manifest: \`${run.evidenceManifestSha256}\``,
        `- Analysis: \`${run.analysisSha256}\``,
        "",
      );
    }
  }
  lines.push("## Limitations", "", ...report.limitations.map((value) => `- ${value}`), "");
  return `${lines.join("\n")}\n`;
}

async function readEvaluation(evidence: VerifiedEvidence): Promise<EvaluationDocument | undefined> {
  try {
    return validateEvaluationDocument(
      JSON.parse((await readVerifiedEvidenceFile(evidence, "evaluation.json")).toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

async function diffSummary(evidence: VerifiedEvidence): Promise<DiffSummary> {
  const diff = await readVerifiedEvidenceFile(evidence, "diff.patch");
  if (diff.byteLength === 0) {
    return {
      files: 0,
      additions: 0,
      deletions: 0,
      testFiles: 0,
      testAdditions: 0,
      productionFiles: 0,
      productionAdditions: 0,
    };
  }
  const diffPath = join(evidence.path, "diff.patch");
  const output = await repositoryCommand(
    "git",
    ["apply", "--numstat", diffPath],
    tmpdir(),
    30_000,
    false,
  );
  const rows = output.split("\n").filter(Boolean).map(parseNumstatRow);
  const tests = rows.filter((row) => isTestPath(row.path));
  const production = rows.filter((row) => !isTestPath(row.path));
  return {
    files: rows.length,
    additions: sum(rows, "additions"),
    deletions: sum(rows, "deletions"),
    testFiles: tests.length,
    testAdditions: sum(tests, "additions"),
    productionFiles: production.length,
    productionAdditions: sum(production, "additions"),
  };
}

function parseNumstatRow(line: string): { additions: number; deletions: number; path: string } {
  const parts = line.split("\t");
  const [additions, deletions, path] = parts;
  if (
    parts.length !== 3 ||
    !additions ||
    !deletions ||
    !path ||
    !/^\d+$/u.test(additions) ||
    !/^\d+$/u.test(deletions)
  ) {
    throw new Error("Benchmark diff contains unsupported binary or renamed data");
  }
  return { additions: Number(additions), deletions: Number(deletions), path };
}

function sum(
  rows: Array<{ additions: number; deletions: number }>,
  key: "additions" | "deletions",
): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

function modeOrder(mode: BenchmarkMode): number {
  return mode === "direct" ? 0 : 1;
}

function yesNo(value: boolean | null): string {
  return value === null ? "n/a" : value ? "yes" : "no";
}

function mutationLabel(run: RunCaseCard): string {
  return run.mutation.killRate === null
    ? "n/a"
    : `${run.mutation.killed}/${run.mutation.total} (${Math.round(run.mutation.killRate * 100)}%)`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("`", "\\`");
}

function fileCount(value: number): string {
  return `${value} ${value === 1 ? "file" : "files"}`;
}
