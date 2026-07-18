import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactValidationError,
  validateSmokeArtifact,
} from "../src/schemas.js";

test("accepts a valid structured artifact", () => {
  assert.deepEqual(validateSmokeArtifact({ kind: "smoke", message: "ready" }), {
    kind: "smoke",
    message: "ready",
  });
});

test("rejects malformed structured artifacts", () => {
  assert.throws(
    () => validateSmokeArtifact({ kind: "smoke", message: "" }),
    ArtifactValidationError,
  );
});
