import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { validContract, validEvidence, validPlan } from "../support/artifacts.js";

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

let threadNumber = 0;
let turnNumber = 0;
let verifierNumber = 0;
const mode = process.argv[2] ?? "default";
if (mode === "stderr") process.stderr.write("private-app-server-stderr-marker\n");
const lines = createInterface({ input: process.stdin });
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

interface PendingCompletion {
  threadId: string;
  turnId: string;
  text: string;
}

let pendingCompletion: PendingCompletion | undefined;

function completeTurn({ threadId, turnId, text }: PendingCompletion): void {
  if (mode === "tool-notification") {
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: {
          type: "commandExecution",
          id: `command-${turnNumber}`,
          command: "private-command-marker",
          cwd: "/private/path",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "private-output-marker",
          exitCode: 0,
          durationMs: 12,
        },
      },
    });
  }
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: {
        type: "agentMessage",
        id: `item-${turnNumber}`,
        text,
        phase: null,
        memoryCitation: null,
      },
    },
  });
  if (mode === "malformed-token-usage") {
    send({
      method: "thread/tokenUsage/updated",
      params: { threadId, turnId, tokenUsage: { total: { inputTokens: "invalid" } } },
    });
    return;
  }
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId,
      tokenUsage: {
        total: {
          totalTokens: turnNumber * 100,
          inputTokens: turnNumber * 70,
          cachedInputTokens: turnNumber * 20,
          outputTokens: turnNumber * 30,
          reasoningOutputTokens: turnNumber * 10,
        },
        last: {
          totalTokens: 100,
          inputTokens: 70,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 200000,
      },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: 1,
      },
    },
  });
}

async function structuredOutput(prompt: string): Promise<unknown> {
  const python = mode === "python";
  if (prompt.includes("[CHANGESAFELY_ROLE:discovery]")) {
    if (mode === "malformed") return { summary: "missing required fields" };
    return validEvidence({
      summary: python
        ? "Small Python fixture with one source file."
        : "Small TypeScript fixture with one source file.",
      facts: [
        {
          id: "F1",
          claim: "The source is under src.",
          references: [
            {
              path: python ? "src/value.py" : "src/value.ts",
              detail: "exports the current value",
            },
          ],
        },
      ],
      commands: [
        {
          name: "test",
          argv: python ? ["python", "-m", "pytest"] : ["npm", "test"],
          purpose: "Run tests",
        },
      ],
      testGaps: ["Requested behavior has no acceptance test."],
      constraints: ["Keep the public function stable."],
      assumptions: [],
    });
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:contract]")) {
    return validContract({
      goal: "Add the requested behavior with a minimal verified change.",
      acceptanceCriteria: [{ id: "AC1", statement: "Requested behavior is observable." }],
      protectedInvariants: [{ id: "INV1", statement: "Public API remains stable." }],
      nonGoals: ["No dependency changes."],
      approvalRequiredChanges: ["New production dependencies"],
      evidenceGaps: ["Acceptance test is missing."],
      risks: ["Behavioral regression."],
      allowedPathPrefixes: python ? ["src", "tests"] : ["src", "test"],
    });
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:planner]")) {
    const planId = prompt.match(/planner (plan-\d+)/)?.[1] ?? "plan-1";
    const lens = prompt.match(/lens is: ([a-z-]+)/)?.[1] ?? "minimal-change";
    if (mode === "out-of-order") {
      const delay = planId === "plan-1" ? 40 : planId === "plan-2" ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return validPlan({
      planId,
      lens,
      title: `${lens} fixture plan`,
      approach: `Use the ${lens} approach in the existing module.`,
      rationale: "It is bounded and directly testable.",
      ...(python
        ? {
            files: [
              { path: "tests/test_value.py", purpose: "Acceptance coverage" },
              { path: "src/value.py", purpose: "Implementation" },
            ],
            steps: [
              {
                id: "S1",
                description: "Add the failing acceptance test.",
                paths: ["tests/test_value.py"],
              },
              { id: "S2", description: "Implement the behavior.", paths: ["src/value.py"] },
            ],
          }
        : {}),
      safetyTests: [
        {
          name: "acceptance",
          proves: "AC1 and INV1",
          argv: python
            ? ["python", "-m", "pytest"]
            : mode === "planner-correction" && !prompt.includes("[CHANGESAFELY_CORRECTION]")
              ? ["npm", "run", "typecheck"]
              : ["npm", "test"],
        },
      ],
      verificationCommands:
        mode === "plan-command"
          ? [
              {
                name: "selected plan check",
                argv: ["npm", "run", "check:plan"],
                purpose: "Verify the selected plan contract",
              },
            ]
          : [
              {
                name: "test",
                argv: python ? ["python", "-m", "pytest"] : ["npm", "test"],
                purpose: "Verify behavior",
              },
            ],
    });
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:judge]")) {
    if (mode === "judge-correction" && !prompt.includes("[CHANGESAFELY_CORRECTION]")) {
      return {
        winnerPlanId: "plan-1",
        reason: "The plan is eligible but a residual policy question remains.",
        rejectedPlans: [],
        tradeoffs: [],
        residualRisks: ["Fixture policy is intentionally narrow."],
        humanDecisionRequired: true,
        humanDecisionReason: "Confirm the existing fixture policy.",
      };
    }
    return {
      winnerPlanId: "plan-1",
      reason: "It is the smallest admissible plan.",
      rejectedPlans: [
        { planId: "plan-2", reason: "Less direct." },
        { planId: "plan-3", reason: "Larger risk focus than needed." },
      ],
      tradeoffs: ["Uses the existing module."],
      residualRisks: ["Only fixture evidence is available."],
      humanDecisionRequired: false,
      humanDecisionReason: "",
    };
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:test-author]")) {
    if (python) {
      await mkdir("tests", { recursive: true });
      await writeFile(
        "tests/test_value.py",
        "from src.value import value\n\n\ndef test_requested_value():\n    assert value() == 2\n",
        "utf8",
      );
      return {
        summary: "Added a failing pytest acceptance test.",
        testPaths: ["tests/test_value.py"],
        fixturePaths: [],
        targetedCommand: {
          name: "targeted acceptance",
          argv: ["python", "-m", "pytest"],
          purpose: "Prove the requested behavior is missing on baseline",
        },
        expectedBaselineOutcome: "fail",
        expectedFailure: "Expected the requested value",
        protectedPaths: ["tests/test_value.py"],
      };
    }
    await mkdir("test", { recursive: true });
    await writeFile(
      "test/value.test.ts",
      `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "../src/value.ts";\n\ntest("requested value", () => {\n  assert.equal(value, 2);\n});\n`,
      "utf8",
    );
    return {
      summary: "Added a failing acceptance test for the requested value.",
      testPaths: ["test/value.test.ts"],
      fixturePaths: [],
      targetedCommand: {
        name: "targeted acceptance",
        argv: ["npm", "test"],
        purpose: "Prove the requested behavior is missing on baseline",
      },
      expectedBaselineOutcome: "fail",
      expectedFailure: "Expected values to be strictly equal",
      protectedPaths: ["test/value.test.ts"],
    };
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:implementer]")) {
    if (python) {
      await writeFile("src/value.py", "def value():\n    return 2\n", "utf8");
      return {
        summary: "Changed the existing Python value implementation.",
        changedPaths: ["src/value.py"],
        testsAdded: [],
        scopeNotes: ["Protected pytest coverage was not changed."],
        residualRisks: [],
      };
    }
    if (mode === "delay-implementer") {
      await mkdir(".changesafely", { recursive: true });
      await writeFile(".changesafely/test-implementer-started", "ready\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    const source =
      mode === "failed-command"
        ? "export const value = 3;\n"
        : mode === "repair"
          ? "export const value = 2; // verifier repair target\n"
          : "export const value = 2;\n";
    await writeFile("src/value.ts", source, "utf8");
    if (mode === "protected-edit") {
      await writeFile("test/value.test.ts", "// weakened\n", "utf8");
    }
    if (mode === "scope-expansion") {
      await writeFile("unexpected.ts", "export {};\n", "utf8");
    }
    if (mode === "protected-config") {
      await writeFile(".env", "CHANGESAFELY_TEST_VALUE=changed\n", "utf8");
    }
    return {
      summary: "Changed the existing value implementation within selected scope.",
      changedPaths: ["src/value.ts"],
      testsAdded: [],
      scopeNotes: ["Protected safety test was not changed."],
      residualRisks: [],
    };
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:repair]")) {
    await writeFile("src/value.ts", "export const value = 2;\n", "utf8");
    return {
      summary: "Removed the concrete local defect reported by the Verifier.",
      changedPaths: ["src/value.ts"],
      testsAdded: [],
      scopeNotes: ["Repair stayed within the selected production path."],
      residualRisks: [],
    };
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:verifier]")) {
    verifierNumber += 1;
    if (mode === "verifier-reject") {
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: true,
        scopeConformant: false,
        evidenceSufficient: true,
        reason: "The implementation does not satisfy the selected plan.",
        findings: [
          {
            code: "PLAN_MISMATCH",
            severity: "error",
            message: "The change cannot be repaired within the selected scope.",
            path: "",
          },
        ],
        residualRisks: [],
      };
    }
    if (mode === "repair" && verifierNumber === 1) {
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: false,
        scopeConformant: true,
        evidenceSufficient: true,
        reason: "A concrete local implementation defect remains.",
        findings: [
          {
            code: "LOCAL_DEFECT",
            severity: "error",
            message: "Remove the temporary implementation marker.",
            path: "src/value.ts",
          },
        ],
        residualRisks: [],
      };
    }
    return {
      verdict: "accept",
      contractFulfilled: true,
      invariantsPreserved: true,
      scopeConformant: true,
      evidenceSufficient: true,
      reason: "Actual diff is scoped and deterministic tests pass.",
      findings: [],
      residualRisks: ["Fixture verification covers only the requested value."],
    };
  }
  return { kind: "smoke", message: "ok" };
}

lines.on("line", async (line) => {
  const message = JSON.parse(line) as Message;
  if (Object.hasOwn(message, "jsonrpc")) {
    if (message.id !== undefined) {
      send({ id: message.id, error: { code: -32600, message: "Unexpected jsonrpc field" } });
    }
    return;
  }
  if (mode === "server-request" && message.id === "approval-1" && !message.method) {
    if (message.error?.code !== -32601 || !pendingCompletion) process.exitCode = 1;
    else completeTurn(pendingCompletion);
    pendingCompletion = undefined;
    return;
  }
  if (message.method === "initialize") {
    if (mode === "request-timeout") return;
    if (mode === "malformed-error") {
      send({ id: message.id, error: { code: "invalid", message: 42 } });
      return;
    }
    send({
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }

  if (message.method === "thread/start" || message.method === "thread/fork") {
    if (
      mode === "expect-permission-profile" &&
      message.method === "thread/start" &&
      (message.params?.sandbox !== undefined ||
        (message.params?.config as Record<string, unknown> | undefined)?.default_permissions !==
          "benchmark-profile")
    ) {
      send({ id: message.id, error: { code: -32602, message: "permission profile mismatch" } });
      return;
    }
    threadNumber += 1;
    send({ id: message.id, result: { thread: { id: `thread-${threadNumber}` } } });
    return;
  }

  if (message.method === "thread/resume") {
    send({
      id: message.id,
      result: { thread: { id: String(message.params?.threadId ?? "thread-unknown") } },
    });
    return;
  }

  if (message.method === "turn/start") {
    if (mode === "expect-permission-profile" && message.params?.sandboxPolicy !== undefined) {
      send({ id: message.id, error: { code: -32602, message: "legacy sandbox override" } });
      return;
    }
    if (
      mode === "expect-permission-profile" &&
      (message.params?.model !== "gpt-5.6-sol" || message.params?.effort !== "medium")
    ) {
      send({ id: message.id, error: { code: -32602, message: "default model mismatch" } });
      return;
    }
    if (
      mode === "expect-spark" &&
      (message.params?.model !== "gpt-5.3-codex-spark" || message.params?.effort !== "low")
    ) {
      send({ id: message.id, error: { code: -32602, message: "model/effort mismatch" } });
      return;
    }
    if (
      mode === "expect-workflow-spark" &&
      (message.params?.model !== "gpt-5.3-codex-spark" || message.params?.effort !== "medium")
    ) {
      send({ id: message.id, error: { code: -32602, message: "model/effort mismatch" } });
      return;
    }
    turnNumber += 1;
    const turnId = `turn-${turnNumber}`;
    const threadId = String(message.params?.threadId ?? "thread-unknown");
    const input = message.params?.input as Array<{ type: string; text?: string }> | undefined;
    const prompt = input?.find((item) => item.type === "text")?.text ?? "";
    const text = JSON.stringify(await structuredOutput(prompt));
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (mode === "malformed-notification") {
      send({ method: "item/completed", params: { turnId } });
      return;
    }
    if (mode === "server-request") {
      pendingCompletion = { threadId, turnId, text };
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {},
      });
      return;
    }
    completeTurn({ threadId, turnId, text });
    return;
  }

  if (message.id !== undefined) send({ id: message.id, result: {} });
});
