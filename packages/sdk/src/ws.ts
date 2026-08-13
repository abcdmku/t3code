import {
  IntegrationWsRpcGroup,
  ORCHESTRATION_WS_METHODS,
} from "@t3tools/contracts/integration/unstable";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { T3TransportError, type T3ClientError } from "./errors.ts";

const DEFAULT_SOCKET_OPEN_TIMEOUT_MS = 15_000;

/**
 * Unstable. Creates the raw integration RPC client. Methods may change without
 * notice. Prefer the SDK methods unless an integration needs an unwrapped RPC.
 * This requires `RpcClient.Protocol`. `unstableWsRpcClient` in `Client.ts`
 * opens an authenticated session.
 */
export const makeWsRpcClient = RpcClient.make(IntegrationWsRpcGroup);

/** The raw integration RPC client type, keyed by RPC tag. */
export type T3WsRpcClient = Effect.Success<typeof makeWsRpcClient>;

export interface T3WsConnectOptions {
  /** Fully resolved `ws(s)://host/ws?wsTicket=value` URL for one session. */
  readonly socketUrl: string;
  readonly openTimeoutMs?: number;
  readonly webSocket?: (url: string, protocols?: string | Array<string>) => globalThis.WebSocket;
}

export type T3WsConnect = (
  options: T3WsConnectOptions,
) => Effect.Effect<T3WsRpcClient, T3ClientError, Scope.Scope>;

const connectWebSocket: T3WsConnect = Effect.fn("t3Sdk.connectWebSocket")((options) =>
  Effect.gen(function* () {
    let constructorFailure: T3TransportError | undefined;
    let reportConstructorFailure!: (error: T3TransportError) => void;
    const constructorFailureSignal = new Promise<T3TransportError>((resolve) => {
      reportConstructorFailure = resolve;
    });
    const createSocket =
      options.webSocket ??
      ((url: string, protocols?: string | Array<string>) =>
        new globalThis.WebSocket(url, protocols));
    const guardedConstructor = function (
      url: string,
      protocols?: string | Array<string>,
    ): globalThis.WebSocket {
      try {
        return createSocket(url, protocols);
      } catch (cause) {
        const failure = new T3TransportError({
          message: `WebSocket construction for ${options.socketUrl} failed.`,
          cause,
          retryable: false,
        });
        constructorFailure = failure;
        reportConstructorFailure(failure);
        throw cause;
      }
    };
    const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, guardedConstructor);
    const socketLayer = Socket.layerWebSocket(options.socketUrl, {
      openTimeout: Duration.millis(options.openTimeoutMs ?? DEFAULT_SOCKET_OPEN_TIMEOUT_MS),
    }).pipe(Layer.provide(constructorLayer));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
    const constructorFailed = Effect.promise(() => constructorFailureSignal).pipe(
      Effect.flatMap(Effect.fail),
    );
    const context = yield* Effect.raceFirst(Layer.build(protocolLayer), constructorFailed);
    const client = yield* makeWsRpcClient.pipe(Effect.provide(context));
    const guard = <A, E>(stream: Stream.Stream<A, E>): Stream.Stream<A, E | T3TransportError> =>
      stream.pipe(
        Stream.catch(
          (error): Stream.Stream<never, E | T3TransportError> =>
            Stream.fail(constructorFailure ?? error),
        ),
        Stream.mergeEffect(constructorFailed),
      );
    return {
      [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
        guard(client[ORCHESTRATION_WS_METHODS.subscribeShell](input)),
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
        guard(client[ORCHESTRATION_WS_METHODS.subscribeThread](input)),
    } as T3WsRpcClient;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new T3TransportError({
          message: `WebSocket connection to ${options.socketUrl} failed.`,
          cause: Cause.squash(cause),
          retryable: false,
        }),
      ),
    ),
  ),
);

/**
 * Internal seam for the websocket transport. The default connects a real
 * WebSocket. Tests can override it with `Layer.succeed(T3WsConnector, stub)`
 * to run subscriptions against an in-memory client.
 */
export class T3WsConnector extends Context.Reference<T3WsConnect>("@t3tools/sdk/ws/T3WsConnector", {
  defaultValue: () => connectWebSocket,
}) {}
