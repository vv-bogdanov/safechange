import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerClient } from "../src/app-server/client.js";
import { smokeArtifactSchema, validateSmokeArtifact } from "../src/schemas.js";
import { withFakeClient } from "./support/app-server.js";

async function startReadOnlyThread(client: AppServerClient) {
  await client.start();
  return client.startThread({
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
  });
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

test("fails closed on a malformed App Server notification", async () => {
  await withFakeClient("malformed-notification", async (client) => {
    const thread = await startReadOnlyThread(client);
    await assert.rejects(
      client.runTurn(thread.thread.id, "Return the smoke artifact.", {
        cwd: process.cwd(),
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: smokeArtifactSchema,
      }),
      /Invalid item\/completed notification/,
    );
  });
});
