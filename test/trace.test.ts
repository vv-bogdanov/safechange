import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunState } from "../src/artifacts.js";
import { RUN_STATE_VERSION } from "../src/schemas.js";
import {
  formatTrace,
  loadTrace,
  MANIFEST_VERSION,
  type RunManifest,
  TRACE_VERSION,
  TraceWriter,
} from "../src/trace.js";
import { VERSION } from "../src/version.js";

function state(repoPath: string): RunState {
  return {
    stateVersion: RUN_STATE_VERSION,
    producerVersion: VERSION,
    runId: "trace-run",
    task: "private task text",
    repoPath,
    baselineCommit: "a".repeat(40),
    baselineFingerprint: "b".repeat(64),
    baselineProtectedConfiguration: {},
    phase: "preflight",
    status: "RUNNING",
    reason: "",
    nextAction: "Continue.",
    artifacts: {},
    contexts: [],
    branch: "",
    testCommit: "",
    implementationCommit: "",
    repairCount: 0,
    model: "",
  };
}

test("writes a private append-only trace with ordered state transitions", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-trace-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const writer = new TraceWriter(repoPath, "trace-run");

  const initial = state(repoPath);
  await writer.recordState(initial);
  const afterStart = await loadTrace(repoPath, "trace-run");
  assert.deepEqual(
    afterStart.events.map(({ event, status }) => [event, status]),
    [
      ["phase.started", "started"],
      ["state.transition", "info"],
    ],
  );
  assert.equal(
    afterStart.events.some((event) => event.event === "phase.finished"),
    false,
  );

  await Promise.all(
    ["one", "two", "three"].map((event) =>
      writer.append({ component: "test", event, status: "info" }),
    ),
  );
  initial.phase = "failed";
  initial.status = "FAILED";
  await writer.recordState(initial);
  await writer.recordFailure(
    "workflow",
    "unexpected",
    new Error("secret message must not be persisted"),
  );

  const document = await loadTrace(repoPath, "trace-run");
  assert.deepEqual(
    document.events.map((event) => event.seq),
    Array.from({ length: document.events.length }, (_, index) => index + 1),
  );
  assert.equal(document.events.at(-2)?.event, "phase.finished");
  assert.equal(document.events.at(-2)?.status, "failed");
  const content = await readFile(document.tracePath, "utf8");
  assert.doesNotMatch(content, /private task text|secret message must not be persisted/);
  assert.match(formatTrace(document), /workflow\.phase\.started/);
  assert.equal(await writer.writeDiagnostic("disabled.log", "raw secret"), undefined);
});

test("persists versioned provenance and opt-in diagnostics with restricted permissions", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-manifest-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const writer = new TraceWriter(repoPath, "manifest-run", true);
  await writer.initializeManifest("test-model");
  await writer.recordRoleProvenance({
    role: "discovery",
    model: "test-model",
    effort: "low",
    sandboxPolicy: "readOnly:network-off",
    promptSha256: "c".repeat(64),
    promptBytes: 321,
    outputSchemaSha256: "d".repeat(64),
  });
  await writer.recordAppServerVersion("codex-app-server/test");
  await writer.completeManifest();
  const diagnosticPath = await writer.writeDiagnostic("command.stderr.log", "bounded raw output");
  assert.equal(diagnosticPath, "diagnostics/command.stderr.log");

  const manifest = JSON.parse(await readFile(writer.manifestPath, "utf8")) as RunManifest;
  assert.equal(manifest.manifestVersion, MANIFEST_VERSION);
  assert.equal(manifest.model, "test-model");
  assert.equal(manifest.appServerUserAgent, "codex-app-server/test");
  assert.equal(manifest.roles[0]?.promptSha256, "c".repeat(64));
  assert.equal(manifest.roles[0]?.promptBytes, 321);
  assert.ok(manifest.completedAt);
  assert.doesNotMatch(JSON.stringify(manifest), /bounded raw output/);

  if (process.platform !== "win32") {
    assert.equal((await stat(writer.runPath)).mode & 0o777, 0o700);
    assert.equal((await stat(writer.tracePath)).mode & 0o777, 0o600);
    assert.equal((await stat(writer.manifestPath)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(writer.runPath, diagnosticPath ?? "missing"))).mode & 0o777,
      0o600,
    );
  }
});

test("clears a terminal manifest timestamp when a run continues", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-active-manifest-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const writer = new TraceWriter(repoPath, "trace-run");
  await writer.initializeManifest("test-model");
  const current = state(repoPath);
  current.phase = "planning-complete";
  current.status = "PLANNED";
  await writer.recordState(current);
  assert.ok((JSON.parse(await readFile(writer.manifestPath, "utf8")) as RunManifest).completedAt);

  current.phase = "test-author";
  current.status = "RUNNING";
  await writer.recordState(current);
  assert.equal(
    (JSON.parse(await readFile(writer.manifestPath, "utf8")) as RunManifest).completedAt,
    null,
  );
});

test("rejects damaged trace JSON and sequence gaps", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-damaged-trace-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const writer = new TraceWriter(repoPath, "damaged-run");
  await writer.initialize();
  await writeFile(
    writer.tracePath,
    `${JSON.stringify({
      traceVersion: TRACE_VERSION,
      seq: 2,
      timestamp: new Date().toISOString(),
      runId: "damaged-run",
      component: "test",
      event: "gap",
      status: "info",
    })}\n`,
    "utf8",
  );
  await assert.rejects(loadTrace(repoPath, "damaged-run"), /Trace sequence/);
  await writeFile(writer.tracePath, "{\n", "utf8");
  await assert.rejects(loadTrace(repoPath, "damaged-run"), /invalid JSON/);
});

test("rejects a damaged or incompatible manifest on resume", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-damaged-manifest-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const writer = new TraceWriter(repoPath, "damaged-manifest");
  await writer.initializeManifest("test-model");
  await writeFile(writer.manifestPath, '{"manifestVersion":999}\n', "utf8");
  await assert.rejects(
    new TraceWriter(repoPath, "damaged-manifest").initialize(),
    /manifest is invalid or incompatible/,
  );
});
