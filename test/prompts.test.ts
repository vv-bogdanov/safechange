import assert from "node:assert/strict";
import test from "node:test";
import {
  changeHarnessPrompt,
  contractPrompt,
  discoveryPrompt,
  HIGH_ASSURANCE_DOCTRINE,
  implementerPrompt,
  judgeCorrectionPrompt,
  judgePrompt,
  plannerCorrectionPrompt,
  plannerPrompt,
  repairPrompt,
  testAuthorPrompt,
  verifierPrompt,
} from "../src/prompts.js";
import type { RepositoryCapabilities } from "../src/repository-capabilities.js";
import { validContract, validEvidence, validPlan } from "./support/artifacts.js";

const capabilities: RepositoryCapabilities = {
  checks: [{ id: "npm:.:test", kind: "test", argv: ["npm", "test"], cwd: "." }],
  testPathPrefixes: ["test"],
  testFilePatterns: ["*.test.ts"],
  controlFiles: ["package.json"],
  sources: ["npm:package.json"],
};

const decision = {
  winnerPlanId: "plan-1",
  reason: "Strongest eligible evidence.",
  rejectedPlans: [],
  tradeoffs: [],
  residualRisks: [],
  humanDecisionRequired: false,
  humanDecisionReason: "",
};

function prompts(): Record<string, string> {
  const contract = validContract();
  const plan = validPlan();
  const eligibility = {
    planId: "plan-1",
    eligible: true,
    failures: [],
    humanDecisionReasons: [],
  };
  return {
    discovery: discoveryPrompt("Change behavior safely.", capabilities),
    contract: contractPrompt("Change behavior safely.", validEvidence()),
    planner: plannerPrompt("plan-1", "risk-first", contract, capabilities),
    "planner-correction": plannerCorrectionPrompt(
      "plan-1",
      "risk-first",
      contract,
      plan,
      eligibility,
      capabilities,
    ),
    judge: judgePrompt(contract, [plan], [eligibility]),
    "judge-correction": judgeCorrectionPrompt(contract, [plan], [eligibility], decision),
    "test-author:characterization": testAuthorPrompt(
      contract,
      plan,
      decision,
      ["test"],
      capabilities,
    ),
    "test-author:change": changeHarnessPrompt(
      contract,
      plan,
      decision,
      "c1",
      {
        summary: "Characterization",
        testPaths: ["test/value.characterization.test.ts"],
        fixturePaths: [],
        targetedCommand: {
          name: "test",
          argv: ["npm", "test"],
          cwd: ".",
          purpose: "Characterize",
        },
        expectedBaselineOutcome: "pass",
        expectedFailure: "No failure expected.",
        protectedPaths: ["test/value.characterization.test.ts"],
      },
      ["test"],
      capabilities,
    ),
    implementer: implementerPrompt(contract, plan, decision, "t1", ["test/value.test.ts"]),
    verifier: verifierPrompt({
      contract,
      plan,
      decision,
      baselineCommit: "b0",
      testCommit: "t1",
      implementationCommit: "i1",
      harnessDiff: "HARNESS_ONLY",
      implementationDiff: "IMPLEMENTATION_ONLY",
      commandResults: { harnessBaseline: [], final: [] },
    }),
    repair: repairPrompt({
      contract,
      plan,
      verification: { verdict: "reject", findings: [] },
      protectedPaths: ["test/value.test.ts"],
    }),
  };
}

test("every role receives the compact high-assurance doctrine exactly once", () => {
  for (const [role, prompt] of Object.entries(prompts())) {
    assert.equal(prompt.split(HIGH_ASSURANCE_DOCTRINE).length - 1, 1, role);
    assert.match(prompt, /Objective:/u, role);
    assert.match(prompt, /Boundary:/u, role);
    assert.match(prompt, /Output:/u, role);
  }
});

test("role prompts keep broad reasoning and narrow action boundaries", () => {
  const values = prompts();
  assert.match(values.discovery ?? "", /complete relevant impact surface/u);
  assert.match(values.contract ?? "", /constrain later writes, never read-only inspection/u);
  assert.match(values.contract ?? "", /Classify changeKind/u);
  assert.match(values.contract ?? "", /evidenceBasis/u);
  assert.match(values.planner ?? "", /smallest sufficient production delta/u);
  assert.match(values.planner ?? "", /critical risk in riskMitigation/u);
  assert.match(values.judge ?? "", /strongest executable evidence/u);
  assert.match(values["test-author:characterization"] ?? "", /characterization harness/u);
  assert.match(values["test-author:change"] ?? "", /same Test Author from accepted C1/u);
  assert.match(
    values["test-author:change"] ?? "",
    /stop rather than invent an unsupported oracle/iu,
  );
  assert.match(values.implementer ?? "", /smallest sufficient production delta/u);
  assert.match(values.verifier ?? "", /try to falsify/u);
  assert.match(values.verifier ?? "", /plausible green-but-wrong/u);
  assert.match(values.repair ?? "", /contract, harness, or scope/u);
});

test("distilled prompts omit obsolete micromanagement", () => {
  const combined = Object.values(prompts()).join("\n");
  assert.doesNotMatch(combined, /minimum meaningful safety harness/iu);
  assert.doesNotMatch(combined, /each prose field to one concise sentence/iu);
  assert.doesNotMatch(combined, /choose the simplest admissible plan/iu);
  assert.doesNotMatch(combined, /at least \d+/iu);
});

test("Verifier receives separate harness and implementation boundaries", () => {
  const prompt = prompts().verifier ?? "";
  assert.match(prompt, /T1 test additions as the required Test Author phase/u);
  assert.match(prompt, /assess production scope only from T1 to I1/u);
  assert.match(prompt, /"harnessDiff": "HARNESS_ONLY"/u);
  assert.match(prompt, /"implementationDiff": "IMPLEMENTATION_ONLY"/u);
});
