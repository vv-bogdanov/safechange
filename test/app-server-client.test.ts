import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AppServerClient } from "../src/app-server/client.js";
import { smokeArtifactSchema, validateSmokeArtifact } from "../src/schemas.js";
import { loadTrace, TraceWriter } from "../src/trace.js";
import { fakeAppServerFactory, withFakeClient } from "./support/app-server.js";

async function startReadOnlyThread(client: AppServerClient) {
  await client.start();
  return client.startThread({
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
  });
}

async function withTracedFakeClient(
  t: TestContext,
  mode: string,
  action: (client: AppServerClient, trace: TraceWriter) => Promise<void>,
): Promise<void> {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-app-server-trace-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const trace = new TraceWriter(repoPath, "app-server-run");
  const client = fakeAppServerFactory(repoPath, mode)();
  client.setTrace(trace);
  try {
    await action(client, trace);
  } finally {
    await client.close();
  }
}

test("completes the App Server handshake and one structured turn", async () => {
  await withFakeClient("expect-spark", async (client) => {
    const initialized = await client.start();
    assert.equal(initialized.userAgent, "fake-app-server");

    const thread = await client.startThread({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    assert.equal(thread.thread.id, "thread-1");

    const result = await client.runTurn("thread-1", "Return the smoke artifact.", {
      cwd: process.cwd(),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: "gpt-5.3-codex-spark",
      effort: "low",
      outputSchema: smokeArtifactSchema,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(validateSmokeArtifact(JSON.parse(result.message)), {
      kind: "smoke",
      message: "ok",
    });
  });
});

test("uses one configured permission profile without a legacy sandbox override", async () => {
  await withFakeClient(
    "expect-permission-profile",
    async (client) => {
      await client.start();
      const thread = await client.startThread({
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const result = await client.runTurn(thread.thread.id, "Return the smoke artifact.", {
        cwd: process.cwd(),
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: "gpt-5.6-sol",
        effort: "medium",
        outputSchema: smokeArtifactSchema,
      });
      assert.equal(result.status, "completed");
    },
    { permissionProfile: "benchmark-profile" },
  );
});

test("rejects unsupported App Server requests and continues the turn", async () => {
  await withFakeClient("server-request", async (client) => {
    const thread = await startReadOnlyThread(client);
    const result = await client.runTurn(thread.thread.id, "Return the smoke artifact.", {
      cwd: process.cwd(),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: smokeArtifactSchema,
    });
    assert.deepEqual(validateSmokeArtifact(JSON.parse(result.message)), {
      kind: "smoke",
      message: "ok",
    });
  });
});

test("fails closed on a malformed App Server notification without persisting its body", async (t) => {
  await withTracedFakeClient(t, "malformed-notification", async (client, trace) => {
    const thread = await startReadOnlyThread(client);
    await assert.rejects(
      client.runTurn(thread.thread.id, "Return the smoke artifact.", {
        cwd: process.cwd(),
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: smokeArtifactSchema,
      }),
      /Invalid item\/completed notification/,
    );
    const document = await loadTrace(trace.repoPath, trace.runId);
    const failure = document.events.find((event) => event.event === "protocol.message");
    assert.equal(failure?.status, "failed");
    assert.ok(failure?.payloadBytes);
    assert.match(failure?.payloadSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.doesNotMatch(await readFile(document.tracePath, "utf8"), /"params"/);
  });
});

test("persists allowlisted cumulative token usage without raw RPC data", async (t) => {
  await withTracedFakeClient(t, "default", async (client, trace) => {
    const thread = await startReadOnlyThread(client);
    await client.runTurn(thread.thread.id, "Return the smoke artifact.", {
      cwd: process.cwd(),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: smokeArtifactSchema,
    });
    const document = await loadTrace(trace.repoPath, trace.runId);
    const usage = document.events.find((event) => event.event === "token.usage");
    assert.equal(usage?.totalTokens, 100);
    assert.equal(usage?.inputTokens, 70);
    assert.equal(usage?.cachedInputTokens, 20);
    assert.equal(usage?.outputTokens, 30);
    assert.equal(usage?.reasoningTokens, 10);
    assert.doesNotMatch(await readFile(document.tracePath, "utf8"), /modelContextWindow/u);
  });
});

test("persists fork lineage and privacy-safe tool metrics", async (t) => {
  await withTracedFakeClient(t, "tool-notification", async (client, trace) => {
    const root = await startReadOnlyThread(client);
    const child = await client.forkThread({ threadId: root.thread.id });
    const prompt = "Return the smoke artifact.";
    await client.runTurn(child.thread.id, prompt, {
      cwd: process.cwd(),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: smokeArtifactSchema,
      role: "verifier",
      phase: "verification",
    });
    const document = await loadTrace(trace.repoPath, trace.runId);
    const fork = document.events.find((event) => event.event === "thread.forked");
    assert.equal(fork?.parentThreadId, root.thread.id);
    assert.equal(fork?.threadId, child.thread.id);
    const turn = document.events.find(
      (event) => event.event === "turn.executed" && event.status === "started",
    );
    assert.equal(turn?.promptBytes, Buffer.byteLength(prompt));
    const tool = document.events.find((event) => event.event === "item.completed");
    assert.equal(tool?.itemType, "commandExecution");
    assert.equal(tool?.toolFailed, false);
    assert.equal(tool?.durationMs, 12);
    const content = await readFile(document.tracePath, "utf8");
    assert.doesNotMatch(content, /private-command-marker|private-output-marker|private\/path/u);
  });
});

test("fails closed on malformed token usage without persisting its body", async (t) => {
  let failurePersisted = false;
  await withTracedFakeClient(t, "malformed-token-usage", async (client, trace) => {
    const recordFailure = trace.recordFailure.bind(trace);
    t.mock.method(
      trace,
      "recordFailure",
      async (...args: Parameters<TraceWriter["recordFailure"]>) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await recordFailure(...args);
        failurePersisted = true;
      },
    );
    const thread = await startReadOnlyThread(client);
    await assert.rejects(
      client.runTurn(thread.thread.id, "Return the smoke artifact.", {
        cwd: process.cwd(),
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: smokeArtifactSchema,
      }),
      /Invalid thread\/tokenUsage\/updated notification/u,
    );
    const document = await loadTrace(trace.repoPath, trace.runId);
    const failure = document.events.find((event) => event.event === "protocol.message");
    assert.equal(failure?.status, "failed");
    assert.doesNotMatch(await readFile(document.tracePath, "utf8"), /inputTokens.*invalid/u);
  });
  assert.equal(failurePersisted, true);
});

test("fails closed on a malformed App Server error response", async () => {
  await withFakeClient("malformed-error", async (client) => {
    await assert.rejects(client.start(), /Invalid error response from App Server/);
  });
});

test("bounds App Server requests with a concrete timeout trace", async (t) => {
  await withTracedFakeClient(t, "request-timeout", async (client, trace) => {
    await assert.rejects(client.start(), /App Server request initialize timed out/);
    const document = await loadTrace(trace.repoPath, trace.runId);
    assert.ok(
      document.events.some(
        (event) =>
          event.event === "rpc.request" &&
          event.method === "initialize" &&
          event.reasonCode === "APP_SERVER_REQUEST_TIMEOUT",
      ),
    );
  });
});
