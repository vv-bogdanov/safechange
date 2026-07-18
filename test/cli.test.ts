import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("runs the CLI through an npm-style symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "safechange-cli-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const link = join(directory, "safechange");
  await symlink(join(process.cwd(), "dist", "src", "cli.js"), link);

  const { stdout: version } = await execFileAsync(process.execPath, [link, "--version"]);
  const { stdout: help } = await execFileAsync(process.execPath, [link, "--help"]);
  assert.equal(version, "0.1.0\n");
  assert.match(help, /safechange run --task/);
});
