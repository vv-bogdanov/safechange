import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildBenchmarkReport, replayBenchmarkRun } from "../bench/src/report.js";

const goldenRoot = join(process.cwd(), "bench", "golden", "spark-pilot");
const runIds = [
  "tenant-leak-direct-20260719153314861-1cfee783",
  "tenant-leak-changesafely-20260719153505353-e2c443ab",
  "restart-storm-direct-20260719154714179-ec0b7c86",
  "restart-storm-changesafely-20260719154846674-ac381eee",
];

test("published Spark evidence replays and matches its stable report", async () => {
  for (const runId of runIds) {
    const replay = await replayBenchmarkRun(goldenRoot, runId);
    assert.equal(replay.verified, true, runId);
    assert.ok(replay.analysis, runId);
    assert.ok(replay.caseCard, runId);
  }

  const report = await buildBenchmarkReport(goldenRoot);
  assert.equal(report.reportVersion, 2);
  assert.equal(report.comparisons.length, 2);
  assert.ok(report.comparisons.every((comparison) => comparison.paired));
  assert.ok(report.comparisons.every((comparison) => comparison.measurement === "development"));
  assert.deepEqual(JSON.parse(await readFile(join(goldenRoot, "report.json"), "utf8")), report);
});
