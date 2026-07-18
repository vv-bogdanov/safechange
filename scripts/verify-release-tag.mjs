import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_NAME || process.argv[2];
const expected = `v${manifest.version}`;

if (tag !== expected) {
  throw new Error(`Release tag ${tag || "<missing>"} does not match package version ${expected}`);
}

process.stdout.write(`Release tag matches package version ${manifest.version}\n`);
