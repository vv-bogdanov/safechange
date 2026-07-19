import { fileURLToPath } from "node:url";
import { AppServerClient } from "../../src/app-server/client.js";

export function fakeAppServerFactory(repoPath: string, mode = "default"): () => AppServerClient {
  const fixture = fileURLToPath(new URL("../fixtures/fake-app-server.js", import.meta.url));
  return () =>
    new AppServerClient({
      command: process.execPath,
      args: [fixture, mode],
      cwd: repoPath,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    });
}

export async function withFakeClient<T>(
  mode: string,
  action: (client: AppServerClient) => Promise<T>,
): Promise<T> {
  const client = fakeAppServerFactory(process.cwd(), mode)();
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}
