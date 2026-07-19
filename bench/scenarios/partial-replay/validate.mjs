import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScenario } from "../validate.mjs";

try {
  process.stdout.write(
    `${JSON.stringify(await validateScenario(dirname(fileURLToPath(import.meta.url))), null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
