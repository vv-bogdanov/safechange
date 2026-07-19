import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUsableCapabilities,
  authorizeRepositoryCheck,
  capabilitiesSha256,
  discoverRepositoryCapabilities,
  isCapabilityTestPath,
  requireRepositoryCheck,
} from "../src/repository-capabilities.js";
import { createTestRepo } from "./support/repository.js";

test("discovers deterministic npm checks in root and nested packages", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: {
      "package.json": `${JSON.stringify({ scripts: { test: "node --test", lint: "biome check .", deploy: "no" } })}\n`,
      "package-lock.json": "{}\n",
      "packages/api/package.json": `${JSON.stringify({ scripts: { "test:unit": "node --test", typecheck: "tsc" } })}\n`,
      "packages/api/test/value.test.js": "// test\n",
    },
  });

  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.deepEqual(
    capabilities.checks.map(({ id, kind, argv, cwd }) => ({ id, kind, argv, cwd })),
    [
      {
        id: "npm:.:lint",
        kind: "lint",
        argv: ["npm", "run", "lint"],
        cwd: ".",
      },
      { id: "npm:.:test", kind: "test", argv: ["npm", "test"], cwd: "." },
      {
        id: "npm:packages/api:test:unit",
        kind: "test",
        argv: ["npm", "run", "test:unit"],
        cwd: "packages/api",
      },
      {
        id: "npm:packages/api:typecheck",
        kind: "typecheck",
        argv: ["npm", "run", "typecheck"],
        cwd: "packages/api",
      },
    ],
  );
  assert.deepEqual(
    capabilities.sources.filter((source) => source.startsWith("npm:")),
    ["npm:package.json", "npm:packages/api/package.json"],
  );
  assert.ok(capabilities.sources.some((source) => source.startsWith("executable:npm:/")));
  assert.equal(isCapabilityTestPath(capabilities, "packages/api/test/value.test.js"), true);
  assert.equal(isCapabilityTestPath(capabilities, "src/value.ts"), false);
  assert.doesNotThrow(() => assertUsableCapabilities(capabilities));
});

test("capability authorization is exact and content addressed", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: { "package.json": `${JSON.stringify({ scripts: { test: "node --test" } })}\n` },
  });
  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.ok(authorizeRepositoryCheck(capabilities, ["npm", "test"], ".", "test"));
  assert.equal(
    authorizeRepositoryCheck(capabilities, ["npm", "test", "--", "value"], ".", "test"),
    undefined,
  );
  assert.throws(
    () => requireRepositoryCheck(capabilities, ["npm", "run", "deploy"]),
    /not in the baseline repository capability catalog/u,
  );
  assert.match(capabilitiesSha256(capabilities), /^[a-f0-9]{64}$/u);
  assert.equal(capabilitiesSha256(capabilities), capabilitiesSha256(capabilities));
});

test("unsupported repositories fail closed without a detected test check", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: { "package.json": `${JSON.stringify({ scripts: { build: "tsc" } })}\n` },
  });
  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.throws(() => assertUsableCapabilities(capabilities), /No deterministic repository test/u);
});
