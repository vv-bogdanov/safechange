import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const args = process.argv.slice(3);
const expectedTask =
  process.env.BENCHMARK_EXPECTED_TASK ??
  "Make payment retries idempotent.\nKeep the public API unchanged.\nDo not add a production dependency.\n";
if (!mode) throw new Error("fake benchmark worker configuration is missing");

if (mode === "direct") {
  const prompt = await readStdin();
  requireValue(prompt === expectedTask, "Direct task bytes differ");
  requireValue(args.includes("exec"), "Direct exec command is missing");
  requireValue(args.includes("--json"), "Direct JSONL flag is missing");
  requireValue(args.includes("--ephemeral"), "Direct ephemeral flag is missing");
  requireValue(
    args.includes('default_permissions="changesafely-benchmark"'),
    "Direct permission profile is missing",
  );
  await writeCandidate("direct");
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started", turn_id: "fake-turn" });
  emit({
    type: "item.completed",
    item: { id: "reasoning-1", type: "reasoning", text: "private-reasoning-marker" },
  });
  emit({
    type: "item.completed",
    item: {
      id: "command-1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "private-command-output-marker",
      exit_code: 0,
    },
  });
  emit({
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "Fake Direct completed." },
  });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    },
  });
} else if (mode === "changesafely") {
  const task = option("--task");
  requireValue(task === expectedTask, "ChangeSafely task bytes differ");
  requireValue(option("--plans") === "3", "ChangeSafely plan count differs");
  requireValue(
    option("--permission-profile") === "changesafely-benchmark",
    "ChangeSafely permission profile differs",
  );
  requireValue(args.includes("--diagnostics"), "ChangeSafely diagnostics flag is missing");
  await writeCandidate("changesafely");
  const runPath = join(process.cwd(), ".changesafely", "runs", "fake-run");
  await mkdir(runPath, { recursive: true });
  await writeFile(
    join(runPath, "trace.jsonl"),
    [
      JSON.stringify({
        traceVersion: 1,
        seq: 1,
        timestamp: "2026-07-19T00:00:00.000Z",
        runId: "fake-run",
        component: "workflow",
        event: "phase.started",
        status: "started",
        phase: "verification",
      }),
      JSON.stringify({
        traceVersion: 1,
        seq: 2,
        timestamp: "2026-07-19T00:00:00.100Z",
        runId: "fake-run",
        component: "role",
        event: "turn.executed",
        status: "started",
        phase: "verification",
        role: "verifier",
        threadId: "fake-thread",
      }),
      JSON.stringify({
        traceVersion: 1,
        seq: 3,
        timestamp: "2026-07-19T00:00:00.900Z",
        runId: "fake-run",
        component: "app-server",
        event: "token.usage",
        status: "info",
        threadId: "fake-thread",
        turnId: "fake-turn",
        totalTokens: 200,
        inputTokens: 140,
        cachedInputTokens: 50,
        outputTokens: 60,
        reasoningTokens: 15,
      }),
      JSON.stringify({
        traceVersion: 1,
        seq: 4,
        timestamp: "2026-07-19T00:00:01.000Z",
        runId: "fake-run",
        component: "role",
        event: "turn.executed",
        status: "completed",
        phase: "verification",
        role: "verifier",
        threadId: "fake-thread",
        turnId: "fake-turn",
        model: "gpt-5.3-codex-spark",
        effort: "medium",
        durationMs: 900,
      }),
      JSON.stringify({
        traceVersion: 1,
        seq: 5,
        timestamp: "2026-07-19T00:00:01.100Z",
        runId: "fake-run",
        component: "workflow",
        event: "phase.finished",
        status: "completed",
        phase: "verification",
      }),
      "",
    ].join("\n"),
  );
  await writeFile(join(runPath, "state.json"), '{"status":"VERIFIED"}\n');
  process.stdout.write(
    `${JSON.stringify({
      outcomeVersion: 2,
      runId: "fake-run",
      status: "VERIFIED",
      reason: "Fake ChangeSafely completed.",
      nextAction: "Inspect evidence.",
    })}\n`,
  );
} else if (mode === "changesafely-no-trace") {
  const task = option("--task");
  requireValue(task === expectedTask, "ChangeSafely task bytes differ");
  requireValue(option("--plans") === "3", "ChangeSafely plan count differs");
  requireValue(
    option("--permission-profile") === "changesafely-benchmark",
    "ChangeSafely permission profile differs",
  );
  requireValue(args.includes("--diagnostics"), "ChangeSafely diagnostics flag is missing");
  await writeCandidate("changesafely");
  process.stdout.write(
    `${JSON.stringify({
      outcomeVersion: 2,
      runId: "missing-trace-run",
      status: "FAILED",
      reason: "Fake ChangeSafely failed after producing a product outcome.",
      nextAction: "Inspect persisted evidence.",
    })}\n`,
  );
  process.exitCode = 1;
} else if (mode === "changesafely-invalid-output") {
  const task = option("--task");
  requireValue(task === expectedTask, "ChangeSafely task bytes differ");
  requireValue(args.includes("--diagnostics"), "ChangeSafely diagnostics flag is missing");
  await writeCandidate("changesafely");
  process.stdout.write("not a JSON outcome, but still useful local diagnostics\n");
  process.stderr.write("fake app server stderr diagnostic\n");
  process.exitCode = 1;
} else {
  throw new Error(`unknown fake benchmark mode: ${mode}`);
}

async function readStdin(): Promise<string> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const parts: string[] = [];
  for await (const line of lines) parts.push(line);
  return parts.join("\n") + (expectedTask?.endsWith("\n") ? "\n" : "");
}

async function writeCandidate(label: string): Promise<void> {
  await mkdir(join(process.cwd(), "test"), { recursive: true });
  await writeFile(
    join(process.cwd(), "test", `${label}.test.ts`),
    `export const mode = "${label}";\n`,
  );
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
