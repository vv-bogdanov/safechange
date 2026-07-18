#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadArtifact, loadRunState } from "./artifacts.js";
import { PreflightError } from "./git.js";
import { resumeRun, runFullWorkflow } from "./orchestrator.js";
import type { DecisionArtifact } from "./schemas.js";
import { VERSION } from "./version.js";
import { runPlanning } from "./workflow.js";

const HELP = `SafeChange ${VERSION}

Usage:
  safechange plan --task <text> [--plans 1..5] [--repo <path>]
  safechange run --task <text> [--plans 1..5] [--repo <path>]
  safechange resume --run <run-id> [--repo <path>]

Commands:
  plan      Compare plans without changing tracked repository state
  run       Execute the complete test-first change workflow
  resume    Continue a persisted run from a validated phase boundary

Options:
  -h, --help       Show this help
  -v, --version    Show the SafeChange version
`;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function printRunSummary(repoPath: string, runId: string, reportPath: string): Promise<void> {
  const state = await loadRunState(repoPath, runId);
  let selectedPlan = "none";
  if (state.artifacts.decision) {
    selectedPlan = (await loadArtifact<DecisionArtifact>(repoPath, runId, "decision.json")).payload
      .winnerPlanId;
  }
  process.stdout.write(
    [
      `Run: ${runId}`,
      `Phase: ${state.phase}`,
      `Selected plan: ${selectedPlan}`,
      `Status: ${state.status}`,
      `Model: ${state.model || "default"}`,
      ...(state.branch ? [`Branch: ${state.branch}`] : []),
      ...(state.testCommit ? [`T1: ${state.testCommit}`] : []),
      ...(state.implementationCommit ? [`Implementation: ${state.implementationCommit}`] : []),
      `Report: ${reportPath}`,
      `Reason: ${state.reason || "none"}`,
      `Next action: ${state.nextAction || "none"}`,
      "",
    ].join("\n"),
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      task: { type: "string" },
      plans: { type: "string", default: "3" },
      repo: { type: "string", default: process.cwd() },
      run: { type: "string" },
    },
  });

  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = parsed.positionals[0];
  if (command !== "plan" && command !== "run" && command !== "resume") {
    process.stderr.write(`Unknown command: ${command ?? ""}\n\n${HELP}`);
    return 1;
  }
  try {
    const repoPath = resolve(requiredString(parsed.values.repo, "--repo"));
    if (command === "resume") {
      const runId = requiredString(parsed.values.run, "--run");
      const result = await resumeRun(repoPath, runId);
      await printRunSummary(repoPath, result.runId, result.reportPath);
      return result.status === "VERIFIED" ? 0 : result.status === "FAILED" ? 1 : 2;
    }
    const task = requiredString(parsed.values.task, "--task");
    const testModel = process.env.SAFECHANGE_LIVE_TEST_MODEL?.trim() || undefined;
    const plannerCount = Number(parsed.values.plans);
    if (!Number.isInteger(plannerCount) || plannerCount < 1 || plannerCount > 5) {
      throw new Error("--plans must be an integer from 1 to 5");
    }
    const result =
      command === "plan"
        ? await runPlanning({
            repoPath,
            task,
            plannerCount,
            requireProtocolMatch: true,
            parallelPlanners: true,
            ...(testModel ? { model: testModel } : {}),
          })
        : await runFullWorkflow({
            repoPath,
            task,
            plannerCount,
            ...(testModel ? { model: testModel } : {}),
          });
    await printRunSummary(repoPath, result.runId, result.reportPath);
    return result.status === "PLANNED" || result.status === "VERIFIED"
      ? 0
      : result.status === "FAILED"
        ? 1
        : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`SafeChange failed: ${message}\n`);
    return error instanceof PreflightError ? 2 : 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
