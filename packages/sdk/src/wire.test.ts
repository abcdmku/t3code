import { describe, expect, it } from "@effect/vitest";
import {
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WsOrchestrationSubscribeShellRpc,
  type OrchestrationShellStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";

import { layer, T3Client } from "./Client.ts";
import { makeWsRpcClient, T3WsConnector, type T3WsConnect } from "./ws.ts";

const BASE_URL = "http://127.0.0.1:5273";
const ISO = "2026-05-01T12:00:00.000Z";

const shellItems: Array<OrchestrationShellStreamItem> = [
  {
    kind: "snapshot",
    snapshot: { snapshotSequence: 3, projects: [], threads: [], updatedAt: ISO },
  },
  { kind: "thread-removed", sequence: 4, threadId: ThreadId.make("thread-4") },
];

const ticketFetch = (() =>
  Promise.resolve(
    Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
  )) satisfies typeof fetch;

describe("wire protocol", () => {
  it.effect(
    "round-trips subscribe items through RpcSerialization.layerJson over an in-memory socket pair",
    () =>
      Effect.gen(function* () {
        // Two cross-wired TransformStreams stand in for one websocket: what
        // the client writes the server reads and vice versa, so every frame
        // passes through the real JSON RPC serialization in both directions.
        const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
        const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
        const serverSocket = yield* Socket.fromTransformStream(
          Effect.succeed({
            readable: clientToServer.readable,
            writable: serverToClient.writable,
          }),
        );
        const clientSocket = yield* Socket.fromTransformStream(
          Effect.succeed({
            readable: serverToClient.readable,
            writable: clientToServer.writable,
          }),
        );

        const group = RpcGroup.make(WsOrchestrationSubscribeShellRpc);
        const serverLayer = RpcServer.layer(group).pipe(
          Layer.provide(
            group.toLayer({
              [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromArray(shellItems),
            }),
          ),
          Layer.provide(RpcServer.layerProtocolSocketServer),
          Layer.provide(
            Layer.succeed(
              SocketServer.SocketServer,
              SocketServer.SocketServer.of({
                address: { _tag: "TcpAddress", hostname: "in-memory", port: 0 },
                run: (handler) =>
                  handler(serverSocket).pipe(Effect.orDie, Effect.andThen(Effect.never)),
              }),
            ),
          ),
          Layer.provide(RpcSerialization.layerJson),
        );
        yield* Layer.build(serverLayer);

        // Mirrors ws.ts's connectWebSocket with the in-memory socket swapped
        // in for `Socket.layerWebSocket`. Protocol, serialization, and the
        // generated WsRpcGroup client stay the real thing.
        const connect: T3WsConnect = () =>
          Effect.gen(function* () {
            const protocolLayer = Layer.effect(
              RpcClient.Protocol,
              RpcClient.makeProtocolSocket(),
            ).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(Socket.Socket, clientSocket),
                  RpcSerialization.layerJson,
                ),
              ),
            );
            const context = yield* Layer.build(protocolLayer);
            return yield* makeWsRpcClient.pipe(Effect.provide(context));
          });

        const items = yield* Effect.gen(function* () {
          const client = yield* T3Client;
          return yield* Stream.runCollect(Stream.take(client.subscribeShell, 2));
        }).pipe(
          Effect.provide(
            layer({
              baseUrl: BASE_URL,
              fetch: ticketFetch,
              auth: { type: "bearer", token: "token-1" },
            }).pipe(Layer.provide(Layer.succeed(T3WsConnector, connect))),
          ),
        );

        expect(items).toEqual(shellItems);
      }).pipe(Effect.scoped),
  );
});
