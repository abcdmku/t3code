import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts/integration";
import * as Effect from "effect/Effect";

import { T3Client } from "./Client.ts";
import type { ArchiveThreadInput, CreateThreadInput, StartTurnInput } from "./commands.ts";
import { T3CapabilityError } from "./errors.ts";

/** Dispatches `thread.create` with `commandId`/`createdAt` filled in. */
export const createThread = Effect.fn("T3Client.createThread")(function* (
  input: CreateThreadInput,
) {
  const client = yield* T3Client;
  return yield* client.dispatch({ ...input, type: "thread.create" });
});

/**
 * Dispatches `thread.turn.start` with the boilerplate the wire schema
 * requires. This fills `commandId`, `messageId`, `createdAt`, `runtimeMode`,
 * `interactionMode`, and the message envelope.
 */
export const startTurn = Effect.fn("T3Client.startTurn")(function* (input: StartTurnInput) {
  const client = yield* T3Client;
  return yield* client.dispatch({ ...input, type: "thread.turn.start" });
});

/** Dispatches `thread.archive` with `commandId` filled in. */
export const archiveThread = Effect.fn("T3Client.archiveThread")(function* (
  input: ArchiveThreadInput,
) {
  const client = yield* T3Client;
  return yield* client.dispatch({ ...input, type: "thread.archive" });
});

/**
 * Fails with `T3CapabilityError` unless the environment's descriptor
 * advertises the capability. The descriptor is how clients handle version
 * differences. Returns the descriptor so callers
 * can branch on other flags without a second fetch.
 */
export const requireCapability = Effect.fn("T3Client.requireCapability")(function* (
  capability: keyof ExecutionEnvironmentCapabilities,
) {
  const client = yield* T3Client;
  const descriptor = yield* client.descriptor;
  const value = descriptor.capabilities[capability];
  if (value !== true && typeof value !== "string") {
    return yield* Effect.fail(
      new T3CapabilityError({
        message: `Environment ${descriptor.environmentId} does not advertise the ${capability} capability.`,
        capability,
      }),
    );
  }
  return descriptor;
});
