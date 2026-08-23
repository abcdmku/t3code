import type { ThreadId } from "@t3tools/contracts/integration";
import * as Effect from "effect/Effect";

import { layer, T3Client } from "./Client.ts";

export { layer };
export type { T3AccessToken, T3ClientAuth, T3ClientConfig } from "./Client.ts";
export type { ArchiveThreadInput, CreateThreadInput, StartTurnInput } from "./commands.ts";
export { archiveThread, createThread, requireCapability, startTurn } from "./operations.ts";
export * from "./errors.ts";

export const descriptor = Effect.gen(function* () {
  const client = yield* T3Client;
  return yield* client.descriptor;
});

export const shell = Effect.gen(function* () {
  const client = yield* T3Client;
  return yield* client.shell;
});

export const thread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const client = yield* T3Client;
    return yield* client.thread(threadId);
  });

export const subscribeShell = Effect.gen(function* () {
  const client = yield* T3Client;
  return client.subscribeShell;
});

export const subscribeThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const client = yield* T3Client;
    return client.subscribeThread(threadId);
  });
