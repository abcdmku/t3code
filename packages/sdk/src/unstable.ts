import * as Effect from "effect/Effect";

import { T3Client, unstableWsRpcClient } from "./Client.ts";

export { T3Client, unstableWsRpcClient };
export { createT3ClientFromLayer } from "./promiseClient.ts";
export type { DispatchableCommandInput } from "./commands.ts";
export type { T3WsRpcClient } from "./ws.ts";

export const dispatch = (command: import("./commands.ts").DispatchableCommandInput) =>
  Effect.gen(function* () {
    const client = yield* T3Client;
    return yield* client.dispatch(command);
  });
