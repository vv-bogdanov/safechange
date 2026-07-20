import { fileURLToPath } from "node:url";
import { AppServerClient, type AppServerClientOptions } from "../../src/app-server/client.js";

export function fakeAppServerFactory(
  repoPath: string,
  mode = "default",
  options: Pick<AppServerClientOptions, "permissionProfile" | "signal"> = {},
): () => AppServerClient {
  const fixture = fileURLToPath(new URL("../fixtures/fake-app-server.js", import.meta.url));
  return () =>
    new AppServerClient({
      command: process.execPath,
      args: [fixture, mode],
      cwd: repoPath,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
      ...options,
    });
}

export async function withFakeClient<T>(
  mode: string,
  action: (client: AppServerClient) => Promise<T>,
  options: Pick<AppServerClientOptions, "permissionProfile"> = {},
): Promise<T> {
  const client = fakeAppServerFactory(process.cwd(), mode, options)();
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}
