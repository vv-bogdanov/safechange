import assert from "node:assert/strict";
import test from "node:test";
import {
  changeHarnessPrompt,
  contractCorrectionPrompt,
  contractPrompt,
  discoveryPrompt,
  HIGH_ASSURANCE_DOCTRINE,
  harnessCorrectionPrompt,
  harnessVerifierPrompt,
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
import { validContract, validEvidence, validHarness, validPlan } from "./support/artifacts.js";

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
    "contract-correction": contractCorrectionPrompt(
      "Change behavior safely.",
      validEvidence(),
      { risks: [{ id: "R1", relatedIds: ["missing"] }] },
      [{ code: "UNKNOWN_CONTRACT_REFERENCE", message: "R1->missing" }],
    ),
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
      validHarness({ summary: "Characterization" }),
      ["test"],
      capabilities,
    ),
    implementer: implementerPrompt(contract, plan, decision, "t1", ["test/value.test.ts"]),
    "verifier:harness": harnessVerifierPrompt({
      contract,
      plan,
      decision,
      baselineCommit: "b0",
      characterizationCommit: "c1",
      testCommit: "t1",
      characterizationDiff: "CHARACTERIZATION",
      changeDiff: "CHANGE",
      harness: validHarness(),
      protectedPaths: ["test/value.test.ts"],
      coverage: { mode: "matrix" },
      commandResults: [],
    }),
    "test-author:correction": harnessCorrectionPrompt({
      contract,
      plan,
      review: { verdict: "reject" },
      harness: validHarness(),
      immutablePaths: ["test/value.test.ts"],
      allowedTestScopes: ["test"],
    }),
    verifier: verifierPrompt({
      contract,
      plan,
      decision,
      baselineCommit: "b0",
      testCommit: "t1",
      implementationCommit: "i1",
      harnessDiff: "HARNESS_ONLY",
      implementationDiff: "IMPLEMENTATION_ONLY",
      harness: validHarness(),
      harnessReview: { accepted: true },
      commandResults: { characterizationBaseline: [], harnessBaseline: [], final: [] },
      coverage: { baseline: { mode: "matrix" }, final: { mode: "matrix" } },
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
  assert.match(values.contract ?? "", /repository-relative write prefixes only/u);
  assert.match(values.contract ?? "", /exclude read-only evidence or control files/u);
  assert.match(values.contract ?? "", /Classify changeKind/u);
  assert.match(values.contract ?? "", /bounded by a conservative executable policy/u);
  assert.match(values.contract ?? "", /safest local policy/u);
  assert.match(values.contract ?? "", /implementation-mechanism uncertainty/u);
  assert.match(values.contract ?? "", /remaining decision is human or external/u);
  assert.match(
    values.contract ?? "",
    /speculative external detail alone is not a critical unknown/u,
  );
  assert.match(values.contract ?? "", /genuinely decision-blocking critical uncertainty/u);
  assert.match(values.contract ?? "", /evidenceBasis/u);
  assert.match(values["contract-correction"] ?? "", /delete a critical unknown/u);
  assert.match(values.planner ?? "", /smallest sufficient production delta/u);
  assert.match(values.planner ?? "", /riskMitigation, id is/u);
  assert.match(values.planner ?? "", /repository-relative write paths only/u);
  assert.match(values.planner ?? "", /exact contract item id/u);
  assert.match(values.planner ?? "", /approvalRequiredChanges empty for guardrails/u);
  assert.match(values["planner-correction"] ?? "", /missing or unknown coverage ids/u);
  assert.match(values["planner-correction"] ?? "", /never absolute paths/u);
  assert.match(values["planner-correction"] ?? "", /plan id collisions/u);
  assert.match(values.judge ?? "", /strongest executable evidence/u);
  assert.match(values["test-author:characterization"] ?? "", /characterization harness/u);
  assert.match(values["test-author:characterization"] ?? "", /non-interference/u);
  assert.match(values["test-author:characterization"] ?? "", /coveredCriteriaIds only/u);
  assert.match(values["test-author:characterization"] ?? "", /non-goals are explanatory/u);
  assert.match(values["test-author:change"] ?? "", /same Test Author from accepted C1/u);
  assert.match(values["test-author:change"] ?? "", /coveredInvariantIds only/u);
  assert.match(values["test-author:change"] ?? "", /coveredRiskIds only/u);
  assert.match(values["test-author:change"] ?? "", /partial failure/u);
  assert.match(
    values["test-author:change"] ?? "",
    /stop rather than invent an unsupported oracle/iu,
  );
  assert.match(values.implementer ?? "", /smallest sufficient production delta/u);
  assert.match(values["verifier:harness"] ?? "", /plausible green-but-wrong/u);
  assert.match(values["test-author:correction"] ?? "", /Append new test evidence only/u);
  assert.match(values.verifier ?? "", /try to falsify/u);
  assert.match(values.verifier ?? "", /plausible green-but-wrong/u);
  assert.match(values.verifier ?? "", /Reconstruct every acceptance criterion/u);
  assert.match(values.verifier ?? "", /no findings or residual risks/u);
  assert.match(values.verifier ?? "", /IMPLEMENTATION_DEFECT/u);
  assert.match(values.verifier ?? "", /numeric coverage only as supporting evidence/u);
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
  assert.match(prompt, /"harnessReview": \{/u);
  assert.match(prompt, /"characterizationBaseline": \[\]/u);
});
