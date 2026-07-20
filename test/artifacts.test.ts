import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArtifactStore,
  artifactInputs,
  loadRunState,
  loadVerifiedArtifact,
  PersistedVersionError,
  type RunState,
  validateRunId,
} from "../src/artifacts.js";
import {
  ARTIFACT_VERSION,
  HARNESS_EVIDENCE_ARTIFACT_VERSION,
  LEGACY_ARTIFACT_VERSION,
  PREVIOUS_ARTIFACT_VERSION,
  RUN_STATE_VERSION,
  RunStateInvariantError,
} from "../src/schemas.js";
import { VERSION } from "../src/version.js";
import { validContract, validEvidence, validHarness } from "./support/artifacts.js";

const baselineCommit = "a".repeat(40);

function validState(repoPath: string): RunState {
  return {
    stateVersion: RUN_STATE_VERSION,
    producerVersion: VERSION,
    runId: "safe-run",
    task: "Make a bounded change",
    repoPath,
    baselineCommit,
    baselineFingerprint: "b".repeat(64),
    baselineProtectedConfiguration: {},
    phase: "preflight",
    status: "RUNNING",
    reason: "",
    nextAction: "Continue planning.",
    artifacts: {},
    contexts: [],
    branch: "",
    testCommit: "",
    implementationCommit: "",
    repairCount: 0,
    model: "",
  };
}

test("rejects unsafe run ids and artifact paths", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-artifacts-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));

  assert.throws(() => validateRunId("../../outside"), /Invalid ChangeSafely run id/);
  assert.throws(() => new ArtifactStore(repoPath, "../outside", "baseline"));

  const store = new ArtifactStore(repoPath, "safe-run", "baseline");
  await store.initialize();
  await assert.rejects(store.writeText("../outside.json", "unsafe"), /escapes/);
});

test("validates run state on write and load", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-state-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();

  const state = validState(repoPath);
  await store.writeState(state);
  assert.deepEqual(await loadRunState(repoPath, "safe-run"), state);
  await assert.rejects(access(join(store.runPath, "context.json")));

  await assert.rejects(
    store.writeState({ ...state, repairCount: 2 }),
    /Invalid ChangeSafely run state/,
  );
  await assert.rejects(
    store.writeState({ ...state, phase: "verified", status: "RUNNING" }),
    RunStateInvariantError,
  );
  await store.writeText("state.json", `{"stateVersion":${RUN_STATE_VERSION}}\n`);
  await assert.rejects(loadRunState(repoPath, "safe-run"), /Invalid ChangeSafely run state/);
});

test("reports unsupported state versions before full schema validation", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-state-version-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();

  for (const stateVersion of [undefined, 2]) {
    const value = { ...validState(repoPath), stateVersion };
    if (stateVersion === undefined) delete (value as { stateVersion?: number }).stateVersion;
    await store.writeText("state.json", `${JSON.stringify(value)}\n`);
    await assert.rejects(
      loadRunState(repoPath, "safe-run"),
      (error: unknown) =>
        error instanceof PersistedVersionError && error.code === "UNSUPPORTED_STATE_VERSION",
    );
  }
});

test("validates artifact payloads, hashes, and run identity", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-envelope-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  const evidence = validEvidence();
  const stored = await store.writeArtifact("evidence", "discovery", evidence);
  assert.equal(stored.envelope.meta.artifactVersion, ARTIFACT_VERSION);
  assert.equal(stored.envelope.meta.producerVersion, VERSION);
  assert.deepEqual(stored.envelope.meta.inputs, {});
  const state = validState(repoPath);
  state.artifacts.evidence = stored.hash;
  await store.writeState(state);
  assert.equal(
    (await loadVerifiedArtifact(repoPath, state, "evidence")).payload.summary,
    evidence.summary,
  );

  const wrongRunContent = `${JSON.stringify({
    meta: {
      artifactVersion: ARTIFACT_VERSION,
      producerVersion: VERSION,
      runId: "other-run",
      baselineCommit,
      role: "discovery",
      createdAt: new Date().toISOString(),
      inputs: {},
    },
    payload: evidence,
  })}\n`;
  await store.writeText("evidence.json", wrongRunContent);
  state.artifacts.evidence = createHash("sha256").update(wrongRunContent).digest("hex");
  await assert.rejects(loadVerifiedArtifact(repoPath, state, "evidence"), /lineage mismatch/);

  const invalidPayloadContent = `${JSON.stringify({
    meta: { ...stored.envelope.meta },
    payload: { summary: "Missing required evidence fields" },
  })}\n`;
  await store.writeText("evidence.json", invalidPayloadContent);
  state.artifacts.evidence = createHash("sha256").update(invalidPayloadContent).digest("hex");
  await assert.rejects(
    loadVerifiedArtifact(repoPath, state, "evidence"),
    /Invalid evidence artifact/,
  );
});

test("reports unsupported artifact versions before envelope validation", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-envelope-version-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  const stored = await store.writeArtifact("evidence", "discovery", validEvidence());
  const state = validState(repoPath);

  for (const artifactVersion of [undefined, ARTIFACT_VERSION + 1]) {
    const envelope = structuredClone(stored.envelope) as {
      meta: { artifactVersion?: number };
    };
    if (artifactVersion === undefined) delete envelope.meta.artifactVersion;
    else envelope.meta.artifactVersion = artifactVersion;
    const content = `${JSON.stringify(envelope)}\n`;
    await store.writeText("evidence.json", content);
    state.artifacts.evidence = createHash("sha256").update(content).digest("hex");
    await assert.rejects(
      loadVerifiedArtifact(repoPath, state, "evidence"),
      (error: unknown) =>
        error instanceof PersistedVersionError && error.code === "UNSUPPORTED_ARTIFACT_VERSION",
    );
  }
});

test("loads and normalizes a hash-verified artifact v2 contract", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-envelope-v2-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  const state = validState(repoPath);
  const evidence = await store.writeArtifact("evidence", "discovery", validEvidence());
  state.artifacts.evidence = evidence.hash;
  const current = validContract();
  const legacyPayload = {
    goal: current.goal,
    acceptanceCriteria: current.acceptanceCriteria.map(({ id, statement }) => ({ id, statement })),
    protectedInvariants: current.protectedInvariants.map(({ id, statement }) => ({
      id,
      statement,
    })),
    nonGoals: [],
    allowedPathPrefixes: current.allowedPathPrefixes,
    approvalRequiredChanges: [],
    evidenceGaps: [],
    risks: ["Legacy regression risk."],
    unknowns: ["Legacy unresolved behavior."],
  };
  const content = `${JSON.stringify({
    meta: {
      artifactVersion: LEGACY_ARTIFACT_VERSION,
      producerVersion: "0.1.0",
      runId: state.runId,
      baselineCommit,
      role: "contract",
      createdAt: "2026-07-19T00:00:00.000Z",
      inputs: { evidence: evidence.hash },
    },
    payload: legacyPayload,
  })}\n`;
  await store.writeText("contract.json", content);
  state.artifacts.contract = createHash("sha256").update(content).digest("hex");

  const loaded = (await loadVerifiedArtifact(repoPath, state, "contract")).payload;
  assert.equal(loaded.changeKind, "mixed");
  assert.equal(loaded.risks[0]?.critical, true);
  assert.deepEqual(loaded.risks[0]?.relatedIds, ["AC1"]);
  assert.equal(loaded.unknowns[0]?.resolutionStatus, "unresolved");
  assert.deepEqual(loaded.unknowns[0]?.relatedIds, ["AC1"]);
});

test("loads an artifact v3 harness as explicitly unmapped evidence", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-envelope-v3-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  const state = validState(repoPath);
  const current = validHarness();
  const previousPayload = {
    summary: current.summary,
    testPaths: current.testPaths,
    fixturePaths: current.fixturePaths,
    targetedCommand: current.targetedCommand,
    expectedBaselineOutcome: current.expectedBaselineOutcome,
    expectedFailure: current.expectedFailure,
    protectedPaths: current.protectedPaths,
    protectedHashes: { "test/value.characterization.test.ts": "c".repeat(64) },
    testCommit: "d".repeat(40),
  };
  state.artifacts.contract = "1".repeat(64);
  state.artifacts.decision = "2".repeat(64);
  state.artifacts["plan-1"] = "3".repeat(64);
  const content = `${JSON.stringify({
    meta: {
      artifactVersion: PREVIOUS_ARTIFACT_VERSION,
      producerVersion: "0.1.0",
      runId: state.runId,
      baselineCommit,
      role: "test-author",
      createdAt: "2026-07-19T00:00:00.000Z",
      inputs: {
        contract: state.artifacts.contract,
        decision: state.artifacts.decision,
        "plan-1": state.artifacts["plan-1"],
      },
    },
    payload: previousPayload,
  })}\n`;
  await store.writeText("harness.json", content);
  state.artifacts.harness = createHash("sha256").update(content).digest("hex");

  const loaded = (await loadVerifiedArtifact(repoPath, state, "harness")).payload;
  assert.deepEqual(loaded.checks, []);
  assert.equal(loaded.nonInterference.status, "unknown");
});

test("loads a hash-verified v4 harness with explicit unknown coverage", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-envelope-v4-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  const state = validState(repoPath);
  const previousPayload = structuredClone(validHarness()) as Record<string, unknown> & {
    coverage?: unknown;
  };
  delete previousPayload.coverage;
  Object.assign(previousPayload, {
    protectedHashes: { "test/value.characterization.test.ts": "c".repeat(64) },
    testCommit: "d".repeat(40),
  });
  state.artifacts.characterization = "0".repeat(64);
  state.artifacts.contract = "1".repeat(64);
  state.artifacts.decision = "2".repeat(64);
  state.artifacts["plan-1"] = "3".repeat(64);
  const content = `${JSON.stringify({
    meta: {
      artifactVersion: HARNESS_EVIDENCE_ARTIFACT_VERSION,
      producerVersion: "0.1.0",
      runId: state.runId,
      baselineCommit,
      role: "test-author",
      createdAt: "2026-07-20T00:00:00.000Z",
      inputs: {
        characterization: state.artifacts.characterization,
        contract: state.artifacts.contract,
        decision: state.artifacts.decision,
        "plan-1": state.artifacts["plan-1"],
      },
    },
    payload: previousPayload,
  })}\n`;
  await store.writeText("harness.json", content);
  state.artifacts.harness = createHash("sha256").update(content).digest("hex");

  const loaded = (await loadVerifiedArtifact(repoPath, state, "harness")).payload;
  assert.equal(loaded.checks[0]?.id, "CHK-INV1");
  assert.equal(loaded.coverage.status, "unknown");
});

test("binds artifact lineage to named predecessors", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-input-lineage-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  const state = validState(repoPath);
  const evidenceStored = await store.writeArtifact("evidence", "discovery", validEvidence());
  state.artifacts.evidence = evidenceStored.hash;
  const contractStored = await store.writeArtifact(
    "contract",
    "contract",
    validContract({
      goal: "Make the requested change",
      allowedPathPrefixes: ["src"],
    }),
    artifactInputs(state, "evidence"),
  );
  const otherKnownHash = "c".repeat(64);
  const tamperedEnvelope = structuredClone(contractStored.envelope);
  tamperedEnvelope.meta.inputs.evidence = otherKnownHash;
  const content = `${JSON.stringify(tamperedEnvelope)}\n`;
  await store.writeText("contract.json", content);
  state.artifacts.contract = createHash("sha256").update(content).digest("hex");
  state.artifacts["plan-1"] = otherKnownHash;

  await assert.rejects(
    loadVerifiedArtifact(repoPath, state, "contract"),
    /Artifact input lineage mismatch: contract\.json <- evidence/,
  );
});
