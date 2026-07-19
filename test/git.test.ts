import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  acquireRepositoryLock,
  createSafeChangeBranch,
  inspectBaseline,
  PreflightError,
} from "../src/git.js";
import { createTestRepo } from "./support/repository.js";

test("blocks a write phase when non-ignored untracked files exist", async (t) => {
  const repoPath = await createTestRepo(t, { files: { "tracked.txt": "baseline\n" } });
  const baseline = await inspectBaseline(repoPath);
  await writeFile(join(repoPath, "user-notes.txt"), "do not commit\n", "utf8");

  await assert.rejects(
    createSafeChangeBranch(baseline, "test-run"),
    (error: unknown) =>
      error instanceof PreflightError && error.reasonCode === "UNTRACKED_FILES_PRESENT",
  );
});

test("allows only one SafeChange writer per repository", async (t) => {
  const repoPath = await createTestRepo(t, { files: { "tracked.txt": "baseline\n" } });

  const lock = await acquireRepositoryLock(repoPath, "run-1");
  await assert.rejects(
    acquireRepositoryLock(repoPath, "run-2"),
    (error: unknown) => error instanceof PreflightError && error.reasonCode === "REPOSITORY_LOCKED",
  );
  await lock.release();

  const nextLock = await acquireRepositoryLock(repoPath, "run-2");
  await nextLock.release();
});
