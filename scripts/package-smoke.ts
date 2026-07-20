import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliEnvironment,
  createFakeCodex,
  createFunctionalRepository,
  installPackedCli,
  protocolVersion,
  runSuccessful,
} from "../test/support/packed-cli.js";

function runIdFrom(output: string): string {
  const runId = output.match(/^Run: (.+)$/m)?.[1];
  if (!runId) throw new Error(`Installed CLI did not print a run id: ${output}`);
  return runId;
}

const root = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-package-smoke-"));

try {
  const { changesafely, installRoot, setupDemo } = await installPackedCli(root, temporaryRoot);
  await Promise.all([access(changesafely), access(setupDemo)]);

  const npxHelp = await runSuccessful(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--no-install", "changesafely", "--help"],
    installRoot,
  );
  if (!npxHelp.includes("ChangeSafely") || !npxHelp.includes("changesafely run")) {
    throw new Error(`Packed npx entrypoint returned unexpected help: ${npxHelp}`);
  }

  const version = await runSuccessful(changesafely, ["--version"], temporaryRoot);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  if (version !== packageJson.version) {
    throw new Error(
      `Installed CLI version ${version} does not match package ${packageJson.version}`,
    );
  }

  const fakeBin = await createFakeCodex(
    temporaryRoot,
    await protocolVersion(root),
    join(root, "dist", "test", "fixtures", "fake-app-server.js"),
    "expect-workflow-spark",
  );
  const functionalRepo = join(temporaryRoot, "functional-repo");
  await createFunctionalRepository(functionalRepo);
  const functionalEnvironment = cliEnvironment(fakeBin);

  const planOutput = await runSuccessful(
    changesafely,
    [
      "plan",
      "--task",
      "Change the fixture value.",
      "--plans",
      "1",
      "--model",
      "gpt-5.3-codex-spark",
      "--repo",
      functionalRepo,
    ],
    temporaryRoot,
    functionalEnvironment,
  );
  if (
    !planOutput.includes("Status: PLANNED") ||
    !planOutput.includes("Model: gpt-5.3-codex-spark")
  ) {
    throw new Error(`Installed CLI plan did not complete as expected: ${planOutput}`);
  }

  const doctorOutput = JSON.parse(
    await runSuccessful(
      changesafely,
      ["doctor", "--json", "--repo", functionalRepo],
      temporaryRoot,
      functionalEnvironment,
    ),
  ) as { ok?: boolean };
  if (doctorOutput.ok !== true) throw new Error("Installed CLI doctor reported not ready");

  const runOutput = await runSuccessful(
    changesafely,
    [
      "run",
      "--task",
      "Change the fixture value.",
      "--plans",
      "1",
      "--model",
      "gpt-5.3-codex-spark",
      "--repo",
      functionalRepo,
    ],
    temporaryRoot,
    functionalEnvironment,
  );
  const runId = runIdFrom(runOutput);
  if (!runOutput.includes("Status: VERIFIED")) {
    throw new Error(`Installed CLI run did not verify: ${runOutput}`);
  }
  const resumeOutput = await runSuccessful(
    changesafely,
    ["resume", "--run", runId, "--repo", functionalRepo],
    temporaryRoot,
    functionalEnvironment,
  );
  if (!resumeOutput.includes("Status: VERIFIED")) {
    throw new Error(`Installed CLI resume did not preserve verification: ${resumeOutput}`);
  }
  const commits = await runSuccessful("git", ["rev-list", "--count", "HEAD"], functionalRepo);
  if (commits !== "4") {
    throw new Error(`Expected B0, C1, T1, and I1 commits, found ${commits}`);
  }

  const demoRoot = join(temporaryRoot, "demo");
  await runSuccessful(setupDemo, ["--target", demoRoot], temporaryRoot);
  await runSuccessful(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], demoRoot);
  const status = await runSuccessful("git", ["status", "--porcelain=v1"], demoRoot);
  if (status !== "") throw new Error(`Packaged demo is dirty after its baseline test: ${status}`);

  process.stdout.write(`Package smoke passed for changesafely ${version}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
