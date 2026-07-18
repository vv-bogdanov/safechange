import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const generatedRoot = join(process.cwd(), "src", "app-server", "generated");
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

async function generateProtocol(root: string): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await mkdir(join(root, "types"), { recursive: true });
  await mkdir(join(root, "json-schema"), { recursive: true });
  await execFileAsync("codex", ["app-server", "generate-ts", "--out", join(root, "types")], {
    timeout: 30_000,
  });
  await markGeneratedTypesAsDeclarations(join(root, "types"));
  await execFileAsync(
    "codex",
    ["app-server", "generate-json-schema", "--out", join(root, "json-schema")],
    { timeout: 30_000 },
  );
  await writeFile(
    join(root, "protocol-version.json"),
    `${JSON.stringify({ codexVersion: await codexVersion() }, null, 2)}\n`,
    "utf8",
  );
}

async function listFiles(directory: string, root = directory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path, root)));
    } else {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

async function checkProtocol(): Promise<void> {
  const expected = JSON.parse(
    await readFile(join(generatedRoot, "protocol-version.json"), "utf8"),
  ) as {
    codexVersion: string;
  };
  const actual = await codexVersion();
  if (expected.codexVersion !== actual) {
    throw new Error(
      `Codex protocol mismatch: generated with ${expected.codexVersion}, found ${actual}`,
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "safechange-protocol-"));
  const regeneratedRoot = join(temporaryRoot, "generated");
  try {
    await generateProtocol(regeneratedRoot);
    const committedFiles = await listFiles(generatedRoot);
    const regeneratedFiles = await listFiles(regeneratedRoot);
    if (JSON.stringify(committedFiles) !== JSON.stringify(regeneratedFiles)) {
      throw new Error("Codex protocol file list is stale; run npm run protocol:generate");
    }
    for (const file of committedFiles) {
      const [committed, regenerated] = await Promise.all([
        readFile(join(generatedRoot, file)),
        readFile(join(regeneratedRoot, file)),
      ]);
      const matches = file.endsWith(".json")
        ? isDeepStrictEqual(JSON.parse(committed.toString()), JSON.parse(regenerated.toString()))
        : committed.equals(regenerated);
      if (!matches) {
        throw new Error(`Codex protocol file ${file} is stale; run npm run protocol:generate`);
      }
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

const mode = process.argv[2];
if (mode === "--write") {
  await generateProtocol(generatedRoot);
} else if (mode === "--check") {
  await checkProtocol();
} else {
  throw new Error("Expected --write or --check");
}
