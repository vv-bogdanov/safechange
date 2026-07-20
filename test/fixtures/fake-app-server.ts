import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { HarnessArtifact } from "../../src/schemas.js";
import { validContract, validEvidence, validHarness, validPlan } from "../support/artifacts.js";

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

let threadNumber = 0;
let turnNumber = 0;
let verifierNumber = 0;
let harnessVerifierNumber = 0;
let harnessCorrectionNumber = 0;
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

interface FunctionalTarget {
  summary: string;
  allowedPathPrefixes: string[];
  sources: Array<{ path: string; implementation: string }>;
  tests: Array<{ path: string; content: string }>;
  checks: Array<{ name: string; argv: string[]; cwd: string; purpose: string }>;
}

function harnessChecks(
  paths: string[],
  kind: "characterization" | "change",
  sourcePath: string,
): HarnessArtifact["checks"] {
  return paths.map((testPath, index) => ({
    id: `CHK-${kind === "characterization" ? "C" : "T"}${index + 1}`,
    kind,
    testPath,
    coveredCriteriaIds: kind === "change" || mode === "refactor" ? ["AC1"] : [],
    coveredInvariantIds: kind === "characterization" ? ["INV1"] : [],
    coveredRiskIds: kind === "characterization" && mode !== "missing-risk-mapping" ? ["R1"] : [],
    observable:
      kind === "characterization"
        ? "The existing public boundary remains available."
        : "The requested behavior is observable.",
    evidenceBasis: [
      {
        source: kind === "change" ? ("task" as const) : ("preservation" as const),
        detail:
          kind === "change"
            ? "The requested behavior is explicit in the task."
            : "The existing public boundary must be preserved.",
        references:
          kind === "change"
            ? []
            : [{ path: sourcePath, detail: "Existing public behavior boundary." }],
      },
    ],
    expectedBaselineOutcome: kind === "characterization" ? ("pass" as const) : ("fail" as const),
    failureBoundary: "",
    nonInterferenceTarget: "",
  }));
}

function noSharedState(sourcePath: string): HarnessArtifact["nonInterference"] {
  return {
    status: "not-applicable",
    targets: [],
    checkIds: [],
    evidenceBasis: [
      {
        source: "repository",
        detail: "The fixture has no shared state or distinct operation identities.",
        references: [{ path: sourcePath, detail: "Single local behavior boundary." }],
      },
    ],
  };
}

function harnessCoverage(sourcePaths: string[], checkIds: string[]): HarnessArtifact["coverage"] {
  const sourcePath = sourcePaths[0] ?? "src/value.ts";
  const notApplicable = (detail: string): HarnessArtifact["coverage"]["matrix"]["failures"] => ({
    status: "not-applicable",
    detail,
    checkIds: [],
    relatedRiskIds: [],
    evidenceBasis: [
      {
        source: "repository",
        detail,
        references: [{ path: sourcePath, detail: "Local fixture boundary." }],
      },
    ],
  });
  return {
    status: "declared",
    impactedPaths: sourcePaths,
    matrix: {
      branches: {
        status: "covered",
        detail: "The fixture behavior path is exercised.",
        checkIds,
        relatedRiskIds: ["R1"],
        evidenceBasis: [
          {
            source: "repository",
            detail: "The source exposes the behavior under change.",
            references: [{ path: sourcePath, detail: "Impacted implementation." }],
          },
        ],
      },
      stateTransitions: notApplicable("The fixture has no mutable state transition."),
      failures: notApplicable("The fixture has no applicable failure boundary."),
    },
    gaps: [],
  };
}

function characterizationPath(path: string): string {
  if (path.endsWith("_test.php")) return path.replace(/_test\.php$/u, "_characterization_test.php");
  if (/\/test_[^/]+\.py$/u.test(path)) return path.replace(/\.py$/u, "_characterization.py");
  if (path.endsWith("_check.js")) return path.replace(/_check\.js$/u, "_characterization_check.js");
  if (path.includes(".test.")) return path.replace(".test.", ".characterization.test.");
  return `${path}.characterization`;
}

function characterizationContent(content: string): string {
  return content
    .replaceAll("requested", "baseline")
    .replaceAll("Requested", "Baseline")
    .replace("assert.equal(value(), 2);", 'assert.equal(typeof value, "function");')
    .replace("assert value() == 2", "assert callable(value)")
    .replace(
      /check\(value\(\) === 2, '[^']*'\);/u,
      "check(is_callable('value'), 'value must remain callable');",
    );
}

function functionalTarget(value: string): FunctionalTarget | undefined {
  if (value === "python") {
    return {
      summary: "Small Python fixture with one source file.",
      allowedPathPrefixes: ["src", "tests"],
      sources: [{ path: "src/value.py", implementation: "def value():\n    return 2\n" }],
      tests: [
        {
          path: "tests/test_value.py",
          content:
            "from src.value import value\n\n\ndef test_requested_value():\n    assert value() == 2\n",
        },
      ],
      checks: [
        {
          name: "pytest",
          argv: ["python", "-m", "pytest"],
          cwd: ".",
          purpose: "Run the prepared Python tests",
        },
      ],
    };
  }
  if (value === "configured-make") {
    return {
      summary: "Small repository authorized by an explicit make check.",
      allowedPathPrefixes: ["src", "checks"],
      sources: [{ path: "src/value.js", implementation: "exports.value = () => 2;\n" }],
      tests: [
        {
          path: "checks/value_check.js",
          content:
            'const assert = require("node:assert/strict");\nconst test = require("node:test");\nconst { value } = require("../src/value.js");\n\ntest("requested value", () => {\n  assert.equal(value(), 2);\n});\n',
        },
      ],
      checks: [
        {
          name: "make test",
          argv: ["make", "test"],
          cwd: ".",
          purpose: "Run the explicitly configured test target",
        },
      ],
    };
  }
  if (value === "php") {
    return {
      summary: "Small PHP repository authorized by an explicit offline check.",
      allowedPathPrefixes: ["src", "tests"],
      sources: [
        {
          path: "src/value.php",
          implementation:
            "<?php\n\ndeclare(strict_types=1);\n\nfunction value(): int\n{\n    return 2;\n}\n",
        },
      ],
      tests: [
        {
          path: "tests/value_test.php",
          content:
            "<?php\n\ndeclare(strict_types=1);\n\ncheck(value() === 2, 'value must return the requested result');\n",
        },
      ],
      checks: [
        {
          name: "PHP tests",
          argv: ["php", "tests/run.php"],
          cwd: ".",
          purpose: "Run the explicitly configured offline PHP checks",
        },
      ],
    };
  }
  if (value === "polyglot") {
    return {
      summary: "Polyglot fixture with independent JavaScript and Python checks.",
      allowedPathPrefixes: ["producer", "consumer"],
      sources: [
        {
          path: "producer/src/value.js",
          implementation: "exports.value = () => 2;\n",
        },
        {
          path: "consumer/src/value.py",
          implementation: "def value():\n    return 2\n",
        },
      ],
      tests: [
        {
          path: "producer/test/value.test.js",
          content:
            'const assert = require("node:assert/strict");\nconst test = require("node:test");\nconst { value } = require("../src/value.js");\n\ntest("requested producer value", () => {\n  assert.equal(value(), 2);\n});\n',
        },
        {
          path: "consumer/tests/test_value.py",
          content:
            "from src.value import value\n\n\ndef test_requested_consumer_value():\n    assert value() == 2\n",
        },
      ],
      checks: [
        {
          name: "producer tests",
          argv: ["node", "--test"],
          cwd: "producer",
          purpose: "Run the configured producer tests",
        },
        {
          name: "consumer tests",
          argv: ["python", "-m", "pytest"],
          cwd: "consumer",
          purpose: "Run the detected consumer tests",
        },
      ],
    };
  }
  return undefined;
}

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
  const target = functionalTarget(mode);
  if (prompt.includes("[CHANGESAFELY_ROLE:discovery]")) {
    if (mode === "malformed") return { summary: "missing required fields" };
    return validEvidence({
      summary: target?.summary ?? "Small TypeScript fixture with one source file.",
      facts: (target?.sources ?? [{ path: "src/value.ts", implementation: "" }]).map(
        (source, index) => ({
          id: `F${index + 1}`,
          claim: "The source exports the current value.",
          references: [{ path: source.path, detail: "exports the current value" }],
        }),
      ),
      commands: target?.checks ?? [
        { name: "test", argv: ["npm", "test"], cwd: ".", purpose: "Run tests" },
      ],
      testGaps: ["Requested behavior has no acceptance test."],
      constraints: ["Keep the public function stable."],
      assumptions: [],
    });
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:contract]")) {
    const isCorrection = prompt.includes("[CHANGESAFELY_CORRECTION]");
    const sourcePath = target?.sources[0]?.path ?? "src/value.ts";
    const testableRisk = (relatedIds: string[]) => ({
      id: "R1",
      statement: "The requested behavior can regress unless the harness bounds it.",
      critical: true,
      resolutionStatus: "unresolved" as const,
      resolution: "",
      relatedIds,
      evidenceBasis: [
        {
          source: "repository" as const,
          detail: "The local fixture exposes the behavior boundary for executable tests.",
          references: [{ path: sourcePath, detail: "Local behavior boundary." }],
        },
      ],
    });
    const criticalUnknown = {
      id: "U1",
      statement: "The required failure behavior cannot be determined.",
      critical: true,
      resolutionStatus: "unresolved" as const,
      resolution: "",
      relatedIds: ["R1"],
      evidenceBasis: [
        {
          source: "repository" as const,
          detail: "The repository exposes conflicting behavior.",
          references: [{ path: sourcePath, detail: "The unresolved behavior boundary." }],
        },
      ],
    };
    if (mode === "contract-schema-correction" && !isCorrection) {
      return { goal: "missing required contract fields" };
    }
    if (mode === "contract-correction" && !isCorrection) {
      return validContract({ risks: [testableRisk(["AC1", "MISSING"])] });
    }
    if (
      (mode === "contract-correction-critical-retained" ||
        mode === "contract-correction-critical-downgrade") &&
      !isCorrection
    ) {
      return validContract({
        risks: [testableRisk(["AC1", "U1", "MISSING"])],
        unknowns: [criticalUnknown],
      });
    }
    if (mode === "contract-correction-critical-retained" && isCorrection) {
      return validContract({
        risks: [testableRisk(["AC1", "U1"])],
        unknowns: [criticalUnknown],
      });
    }
    if (mode === "contract-correction-critical-downgrade" && isCorrection) {
      return validContract({ risks: [testableRisk(["AC1"])] });
    }
    if (mode === "traceable-contract-graph") {
      return validContract({
        risks: [testableRisk(["AC1", "INV1", "U1", "NG1"])],
        unknowns: [
          {
            id: "U1",
            statement: "The broader runtime deployment policy is locally bounded.",
            critical: false,
            resolutionStatus: "resolved" as const,
            resolution: "The local harness can prove the safety boundary for this change.",
            relatedIds: ["R1", "NG1"],
            evidenceBasis: [
              {
                source: "repository" as const,
                detail: "The fixture has deterministic local evidence for the bounded boundary.",
                references: [{ path: sourcePath, detail: "Local proof boundary." }],
              },
            ],
          },
        ],
        nonGoals: [
          {
            id: "NG1",
            statement: "Do not add deployment policy machinery.",
            evidenceBasis: [
              {
                source: "task" as const,
                detail: "The requested change is local and executable.",
                references: [],
              },
            ],
            relatedRiskIds: ["R1"],
          },
        ],
      });
    }
    return validContract({
      ...(mode === "refactor" ? { changeKind: "refactor" as const } : {}),
      goal: "Add the requested behavior with a minimal verified change.",
      acceptanceCriteria: [
        {
          id: "AC1",
          statement: "Requested behavior is observable.",
          evidenceBasis: [
            { source: "task", detail: "The requested behavior is explicit.", references: [] },
          ],
        },
      ],
      protectedInvariants: [
        {
          id: "INV1",
          statement: "Public API remains stable.",
          evidenceBasis: [
            {
              source: "preservation",
              detail: "The current public API is used by the fixture.",
              references: [
                {
                  path: target?.sources[0]?.path ?? "src/value.ts",
                  detail: "Existing public function.",
                },
              ],
            },
          ],
        },
      ],
      nonGoals: [
        {
          id: "NG1",
          statement: "No dependency changes.",
          evidenceBasis: [
            { source: "task", detail: "The task requires only local behavior.", references: [] },
          ],
          relatedRiskIds: [],
        },
      ],
      approvalRequiredChanges: ["New production dependencies"],
      evidenceGaps: ["Acceptance test is missing."],
      allowedPathPrefixes:
        mode === "absolute-contract-scope"
          ? [`${process.cwd()}/src`, `${process.cwd()}/test`]
          : (target?.allowedPathPrefixes ?? ["src", "test"]),
      ...(mode === "testable-contract-risk"
        ? {
            risks: [
              {
                id: "R1",
                statement:
                  "The requested behavior can regress failure handling unless the harness bounds it.",
                critical: true,
                resolutionStatus: "unresolved" as const,
                resolution: "",
                relatedIds: ["AC1", "INV1", "U1"],
                evidenceBasis: [
                  {
                    source: "repository" as const,
                    detail: "The local fixture exposes the behavior boundary for executable tests.",
                    references: [
                      {
                        path: target?.sources[0]?.path ?? "src/value.ts",
                        detail: "Local behavior boundary.",
                      },
                    ],
                  },
                ],
              },
            ],
            unknowns: [
              {
                id: "U1",
                statement: "The broader runtime policy is not needed for the local proof.",
                critical: false,
                resolutionStatus: "resolved" as const,
                resolution: "The selected plan can bound this through local executable evidence.",
                relatedIds: ["R1"],
                evidenceBasis: [
                  {
                    source: "repository" as const,
                    detail: "The repository exposes a deterministic local test boundary.",
                    references: [
                      {
                        path: target?.sources[0]?.path ?? "src/value.ts",
                        detail: "Deterministic local boundary.",
                      },
                    ],
                  },
                ],
              },
            ],
          }
        : {}),
      ...(mode === "critical-contract-unknown"
        ? {
            unknowns: [
              {
                id: "U1",
                statement: "The required failure behavior cannot be determined.",
                critical: true,
                resolutionStatus: "unresolved" as const,
                resolution: "",
                relatedIds: ["AC1"],
                evidenceBasis: [
                  {
                    source: "repository" as const,
                    detail: "The repository exposes conflicting behavior.",
                    references: [
                      {
                        path: target?.sources[0]?.path ?? "src/value.ts",
                        detail: "The unresolved behavior boundary.",
                      },
                    ],
                  },
                ],
              },
            ],
          }
        : {}),
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
      ...(target
        ? {
            files: [
              ...target.tests.map((item) => ({
                path: characterizationPath(item.path),
                purpose: "Preservation coverage",
              })),
              ...target.tests.map((item) => ({ path: item.path, purpose: "Acceptance coverage" })),
              ...target.sources.map((item) => ({ path: item.path, purpose: "Implementation" })),
            ],
            steps: [
              {
                id: "S1",
                description: "Add baseline-green characterization coverage.",
                paths: target.tests.map((item) => characterizationPath(item.path)),
              },
              {
                id: "S2",
                description: "Add failing acceptance coverage in every target test root.",
                paths: target.tests.map((item) => item.path),
              },
              {
                id: "S3",
                description: "Implement the behavior in every target source.",
                paths: target.sources.map((item) => item.path),
              },
            ],
          }
        : {}),
      safetyTests: target
        ? target.checks.map((check) => ({
            name: check.name,
            proves: "AC1 and INV1",
            argv: check.argv,
            cwd: check.cwd,
          }))
        : [
            {
              name: "acceptance",
              proves: "AC1 and INV1",
              argv:
                mode === "planner-correction" && !prompt.includes("[CHANGESAFELY_CORRECTION]")
                  ? ["npm", "run", "typecheck"]
                  : ["npm", "test"],
              cwd: ".",
            },
          ],
      verificationCommands: target
        ? target.checks
        : mode === "plan-command"
          ? [
              {
                name: "selected plan check",
                argv: ["npm", "run", "check:plan"],
                cwd: ".",
                purpose: "Verify the selected plan contract",
              },
            ]
          : [
              {
                name: "test",
                argv: ["npm", "test"],
                cwd: ".",
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
  if (prompt.includes("[CHANGESAFELY_ROLE:test-author:characterization]")) {
    if (target) {
      for (const item of target.tests) {
        const path = characterizationPath(item.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, characterizationContent(item.content), "utf8");
      }
      const targeted = target.checks[0];
      if (!targeted) throw new Error("Functional target requires one check");
      const testPaths = target.tests.map((item) => characterizationPath(item.path));
      const sourcePath = target.sources[0]?.path ?? "src/value.ts";
      return validHarness({
        summary: "Added baseline-green characterization tests.",
        testPaths,
        fixturePaths: [],
        targetedCommand: targeted,
        expectedBaselineOutcome: "pass",
        expectedFailure: "No failure expected; the baseline behavior must pass.",
        checks: harnessChecks(testPaths, "characterization", sourcePath),
        nonInterference: noSharedState(sourcePath),
        coverage: harnessCoverage(
          target.sources.map((source) => source.path),
          testPaths.map((_, index) => `CHK-C${index + 1}`),
        ),
        protectedPaths: testPaths,
      });
    }
    await mkdir("test", { recursive: true });
    await writeFile(
      "test/value.characterization.test.ts",
      `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "../src/value.ts";\n\ntest("preserves the public value boundary", () => {\n  assert.equal(typeof value, "number");\n});\n`,
      "utf8",
    );
    if (mode === "characterization-production") {
      await writeFile("src/value.ts", "export const value = 2;\n", "utf8");
    }
    const characterization = validHarness({
      summary: "Added a baseline-green characterization test.",
      checks: harnessChecks(
        ["test/value.characterization.test.ts"],
        "characterization",
        "src/value.ts",
      ),
      coverage: harnessCoverage(["src/value.ts"], ["CHK-C1"]),
    });
    if (mode === "invalid-harness-mapping") {
      const check = characterization.checks[0];
      if (!check) throw new Error("Fixture characterization check is missing");
      check.coveredInvariantIds = [];
    }
    return characterization;
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:test-author:change]")) {
    if (mode === "delay-change") {
      await mkdir(".changesafely", { recursive: true });
      await writeFile(".changesafely/test-change-author-started", "ready\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    if (target) {
      for (const item of target.tests) {
        await mkdir(dirname(item.path), { recursive: true });
        await writeFile(item.path, item.content, "utf8");
      }
      const targeted = target.checks[0];
      if (!targeted) throw new Error("Functional target requires one check");
      const testPaths = target.tests.map((item) => item.path);
      const sourcePath = target.sources[0]?.path ?? "src/value.ts";
      return validHarness({
        summary: "Added failing acceptance tests in the declared test roots.",
        testPaths,
        fixturePaths: [],
        targetedCommand: targeted,
        expectedBaselineOutcome: "fail",
        expectedFailure: "Expected the requested value",
        checks: harnessChecks(testPaths, "change", sourcePath),
        nonInterference: noSharedState(sourcePath),
        coverage: harnessCoverage(
          target.sources.map((source) => source.path),
          testPaths.map((_, index) => `CHK-T${index + 1}`),
        ),
        protectedPaths: testPaths,
      });
    }
    await mkdir("test", { recursive: true });
    await writeFile(
      "test/value.test.ts",
      `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "../src/value.ts";\n\ntest("requested value", () => {\n  assert.equal(value, ${mode === "overconstrained-harness" ? 3 : 2});\n});\n`,
      "utf8",
    );
    if (mode === "rewrite-characterization") {
      await writeFile("test/value.characterization.test.ts", "// weakened C1\n", "utf8");
    }
    return validHarness({
      summary: "Added a failing acceptance test for the requested value.",
      testPaths: ["test/value.test.ts"],
      fixturePaths: [],
      targetedCommand: {
        name: "targeted acceptance",
        argv: ["npm", "test"],
        cwd: ".",
        purpose: "Prove the requested behavior is missing on baseline",
      },
      expectedBaselineOutcome: "fail",
      expectedFailure: "Expected values to be strictly equal",
      checks: harnessChecks(["test/value.test.ts"], "change", "src/value.ts"),
      coverage: harnessCoverage(["src/value.ts"], ["CHK-T1"]),
      protectedPaths: ["test/value.test.ts"],
    });
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:verifier:harness]")) {
    harnessVerifierNumber += 1;
    const reject =
      mode === "overconstrained-harness" ||
      mode === "harness-insufficient" ||
      (mode === "harness-correction" && harnessVerifierNumber === 1);
    if (reject) {
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: true,
        scopeConformant: true,
        evidenceSufficient: false,
        reason:
          mode === "overconstrained-harness"
            ? "The acceptance oracle asserts an unsupported value."
            : "A plausible green-but-wrong implementation is not rejected yet.",
        findings: [
          {
            code: mode === "overconstrained-harness" ? "UNSUPPORTED_ORACLE" : "MISSING_EDGE_CHECK",
            severity: "error",
            message:
              mode === "overconstrained-harness"
                ? "The asserted value is not grounded in the task or repository evidence."
                : "Add a separate executable edge check without changing protected evidence.",
            path: "test/value.test.ts",
          },
        ],
        residualRisks: [],
      };
    }
    const reviewedCheckId =
      mode === "harness-invalid-accept"
        ? "CHK-UNKNOWN"
        : target
          ? "CHK-T1"
          : mode === "refactor"
            ? "CHK-C1"
            : "CHK-T1";
    const reviewedPath =
      mode === "harness-invalid-accept"
        ? "test/unprotected.test.ts"
        : (target?.tests[0]?.path ??
          (mode === "refactor" ? "test/value.characterization.test.ts" : "test/value.test.ts"));
    return {
      verdict: "accept",
      contractFulfilled: true,
      invariantsPreserved: true,
      scopeConformant: true,
      evidenceSufficient: true,
      reason: "The grounded protected harness rejects the plausible unsafe implementation.",
      findings: [
        {
          code: "GREEN_WRONG_CAUGHT",
          severity: "warning",
          message: `${reviewedCheckId} rejects an implementation that preserves only the old value.`,
          path: reviewedPath,
        },
      ],
      residualRisks: [],
    };
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:test-author:correction]")) {
    harnessCorrectionNumber += 1;
    const path = `test/value.harness-${harnessCorrectionNumber}.test.ts`;
    await writeFile(
      path,
      `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "../src/value.ts";\n\ntest("reviewed edge ${harnessCorrectionNumber}", () => {\n  assert.equal(value, 2);\n});\n`,
      "utf8",
    );
    const id = `CHK-X${harnessCorrectionNumber}`;
    const correction = validHarness({
      summary: "Added the bounded evidence requested by harness review.",
      testPaths: [path],
      targetedCommand: {
        name: "targeted harness correction",
        argv: ["npm", "test"],
        cwd: ".",
        purpose: "Prove the missing behavior remains absent on baseline",
      },
      expectedBaselineOutcome: "fail",
      expectedFailure: "Expected values to be strictly equal",
      checks: harnessChecks([path], "change", "src/value.ts").map((check) => ({
        ...check,
        id,
      })),
      coverage: harnessCoverage(["src/value.ts"], [id]),
      protectedPaths: [path],
    });
    return correction;
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:implementer]")) {
    if (target) {
      for (const source of target.sources) {
        await writeFile(source.path, source.implementation, "utf8");
      }
      return {
        summary: "Changed the selected target implementations.",
        changedPaths: target.sources.map((item) => item.path),
        testsAdded: [],
        scopeNotes: ["Protected acceptance coverage was not changed."],
        residualRisks: [],
      };
    }
    if (mode === "delay-implementer") {
      await mkdir(".changesafely", { recursive: true });
      await writeFile(".changesafely/test-implementer-started", "ready\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    if (mode === "implementer-replan") {
      return {
        summary: "The selected contract and harness do not support a safe production change.",
        changedPaths: [],
        testsAdded: [],
        scopeNotes: ["No repository path was changed."],
        residualRisks: ["The required behavior needs a corrected contract or harness."],
      };
    }
    const source =
      mode === "refactor"
        ? "export const value = 1; // refactored without behavior change\n"
        : mode === "failed-command"
          ? "export const value = 3;\n"
          : mode === "repair" || mode === "repair-protected-edit"
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
      changedPaths: mode === "incomplete-implementation-artifact" ? [] : ["src/value.ts"],
      testsAdded: [],
      scopeNotes: ["Protected safety test was not changed."],
      residualRisks: [],
    };
  }
  if (prompt.includes("[CHANGESAFELY_ROLE:repair]")) {
    await writeFile("src/value.ts", "export const value = 2;\n", "utf8");
    if (mode === "repair-protected-edit") {
      await writeFile("test/value.test.ts", "// weakened during repair\n", "utf8");
    }
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
    if (mode === "harness-defect-verifier") {
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: true,
        scopeConformant: true,
        evidenceSufficient: true,
        reason: "The protected harness contains an invalid oracle.",
        findings: [
          {
            code: "HARNESS_DEFECT",
            severity: "error",
            message: "Route the invalid oracle back to Test Author.",
            path: "test/value.test.ts",
          },
        ],
        residualRisks: [],
      };
    }
    if (mode === "contract-defect-verifier") {
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: true,
        scopeConformant: true,
        evidenceSufficient: true,
        reason: "The contract does not ground the required production behavior.",
        findings: [
          {
            code: "CONTRACT_DEFECT",
            severity: "error",
            message: "Route the missing semantic decision back to the contract boundary.",
            path: "src/value.ts",
          },
        ],
        residualRisks: [],
      };
    }
    if (mode === "scope-defect-verifier" || mode === "evidence-defect-verifier") {
      const scopeDefect = mode === "scope-defect-verifier";
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: true,
        scopeConformant: !scopeDefect,
        evidenceSufficient: scopeDefect,
        reason: scopeDefect
          ? "The selected production scope cannot contain the required change."
          : "The deterministic evidence cannot establish the required behavior.",
        findings: [
          {
            code: scopeDefect ? "SCOPE_DEFECT" : "EVIDENCE_DEFECT",
            severity: "error",
            message: scopeDefect
              ? "Route the incomplete scope back to planning."
              : "Route the incomplete evidence back to the verification environment.",
            path: scopeDefect ? "src/value.ts" : "",
          },
        ],
        residualRisks: [],
      };
    }
    if ((mode === "repair" || mode === "repair-protected-edit") && verifierNumber === 1) {
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: false,
        scopeConformant: true,
        evidenceSufficient: true,
        reason: "A concrete local implementation defect remains.",
        findings: [
          {
            code: "IMPLEMENTATION_DEFECT",
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
      findings:
        mode === "verifier-warning"
          ? [
              {
                code: "CRITICAL_UNCERTAINTY",
                severity: "warning",
                message: "A required behavior remains uncertain despite the accept verdict.",
                path: target?.sources[0]?.path ?? "src/value.ts",
              },
            ]
          : [],
      residualRisks:
        mode === "verifier-residual-risk"
          ? ["A required behavior remains uncertain despite the accept verdict."]
          : [],
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
    const prefix = message.method === "thread/start" ? "thread" : `fork-${process.pid}`;
    send({ id: message.id, result: { thread: { id: `${prefix}-${threadNumber}` } } });
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
