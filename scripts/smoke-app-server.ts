import { AppServerClient } from "../src/app-server/client.js";
import {
  smokeArtifactSchema,
  validateSmokeArtifact,
} from "../src/schemas.js";

const cwd = process.cwd();
const client = new AppServerClient({ cwd, turnTimeoutMs: 120_000 });

try {
  const initialized = await client.start();
  const started = await client.startThread({
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
  });
  const result = await client.runTurn(
    started.thread.id,
    "Return a JSON object with kind set to smoke and a short non-empty message. Do not inspect files or run commands.",
    {
      cwd,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: smokeArtifactSchema,
    },
  );
  const artifact = validateSmokeArtifact(JSON.parse(result.message));
  process.stdout.write(
    `${JSON.stringify({ userAgent: initialized.userAgent, turnId: result.turnId, artifact })}\n`,
  );
} finally {
  await client.close();
}
