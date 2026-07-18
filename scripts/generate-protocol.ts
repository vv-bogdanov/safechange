import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const generatedRoot = join(process.cwd(), "src", "app-server", "generated");
const versionFile = join(generatedRoot, "protocol-version.json");

async function codexVersion(): Promise<string> {
  const { stdout } = await execFileAsync("codex", ["--version"], {
    timeout: 10_000,
  });
  return stdout.trim();
}

async function markGeneratedTypesAsDeclarations(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await markGeneratedTypesAsDeclarations(path);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      await rename(path, `${path.slice(0, -3)}.d.ts`);
    }
  }
}

async function writeProtocol(): Promise<void> {
  await mkdir(join(generatedRoot, "types"), { recursive: true });
  await mkdir(join(generatedRoot, "json-schema"), { recursive: true });
  await execFileAsync(
    "codex",
    ["app-server", "generate-ts", "--out", join(generatedRoot, "types")],
    { timeout: 30_000 },
  );
  await markGeneratedTypesAsDeclarations(join(generatedRoot, "types"));
  await execFileAsync(
    "codex",
    [
      "app-server",
      "generate-json-schema",
      "--out",
      join(generatedRoot, "json-schema"),
    ],
    { timeout: 30_000 },
  );
  await writeFile(
    versionFile,
    `${JSON.stringify({ codexVersion: await codexVersion() }, null, 2)}\n`,
    "utf8",
  );
}

async function checkProtocol(): Promise<void> {
  const expected = JSON.parse(await readFile(versionFile, "utf8")) as {
    codexVersion: string;
  };
  const actual = await codexVersion();
  if (expected.codexVersion !== actual) {
    throw new Error(
      `Codex protocol mismatch: generated with ${expected.codexVersion}, found ${actual}`,
    );
  }
}

const mode = process.argv[2];
if (mode === "--write") {
  await writeProtocol();
} else if (mode === "--check") {
  await checkProtocol();
} else {
  throw new Error("Expected --write or --check");
}
