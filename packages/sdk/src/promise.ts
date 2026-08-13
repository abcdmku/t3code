import { layer, type T3ClientConfig } from "./Client.ts";
import { createT3ClientFromLayer, type T3PromiseClient } from "./promiseClient.ts";

/**
 * Creates a client for one T3 environment. Methods return promises,
 * subscriptions are async iterables, and errors are plain classes.
 */
export const createT3Client = (config: T3ClientConfig): T3PromiseClient =>
  createT3ClientFromLayer(layer(config));

export type { T3PromiseClient };
export type { ArchiveThreadInput, CreateThreadInput, StartTurnInput } from "./promiseClient.ts";
export type { T3AccessToken, T3ClientAuth, T3ClientConfig } from "./Client.ts";
export * from "./errors.ts";
