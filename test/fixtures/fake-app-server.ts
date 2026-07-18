import { createInterface } from "node:readline";

interface Message {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

const lines = createInterface({ input: process.stdin });
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

lines.on("line", (line) => {
  const message = JSON.parse(line) as Message;
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }

  if (message.method === "thread/fork") {
    send({ id: message.id, result: { thread: { id: "thread-fork-1" } } });
    return;
  }

  if (message.method === "turn/start") {
    const turnId = "turn-1";
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId,
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: "item-1",
          text: '{"kind":"smoke","message":"ok"}',
          phase: null,
          memoryCitation: null,
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: turnId,
          items: [],
          itemsView: { type: "full" },
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: 1,
        },
      },
    });
    return;
  }

  if (message.id !== undefined) send({ id: message.id, result: {} });
});
