import {
  UiControlRequestId,
  type EnvironmentId,
  type UiControlHost,
  type UiControlHostFocus,
  type UiControlInvokeResult,
  type UiControlOperation,
  type UiControlResponse,
  type UiControlStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PENDING_REQUESTS = 64;
const HOST_QUEUE_CAPACITY = MAX_PENDING_REQUESTS * 2 + 1;

export interface UiControlInvokeInput {
  readonly environmentId: EnvironmentId;
  readonly operation: UiControlOperation;
  readonly input: unknown;
  readonly timeoutMs?: number;
}

export class UiControlBroker extends Context.Service<
  UiControlBroker,
  {
    readonly connect: (host: UiControlHost) => Effect.Effect<Stream.Stream<UiControlStreamEvent>>;
    readonly focusHost: (host: UiControlHostFocus) => Effect.Effect<void>;
    readonly respond: (response: UiControlResponse) => Effect.Effect<void>;
    readonly invoke: (request: UiControlInvokeInput) => Effect.Effect<UiControlInvokeResult>;
  }
>()("t3/uiControl/UiControlBroker") {}

interface HostConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly environmentId: UiControlHost["environmentId"];
  readonly supportedOperations: ReadonlySet<UiControlOperation>;
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly queue: Queue.Queue<UiControlStreamEvent>;
}

interface PendingRequest {
  readonly clientId: HostConnection["clientId"];
  readonly connectionId: HostConnection["connectionId"];
  readonly queue: HostConnection["queue"];
  readonly deferred: Deferred.Deferred<UiControlInvokeResult>;
}

interface BrokerState {
  readonly hosts: ReadonlyMap<string, HostConnection>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly requestSequence: number;
  readonly focusSequence: number;
}

type RouteDecision =
  | { readonly type: "busy" }
  | { readonly type: "missing" }
  | {
      readonly type: "routed";
      readonly connection: HostConnection;
      readonly requestId: UiControlRequestId;
    };

const undelivered = (error: string): UiControlInvokeResult => ({ delivered: false, error });

const removeConnectionFromState = (
  current: BrokerState,
  clientId: string,
  queue: HostConnection["queue"],
): { readonly state: BrokerState; readonly disconnected: ReadonlyArray<PendingRequest> } => {
  const hosts = new Map(current.hosts);
  const pending = new Map(current.pending);
  const disconnected: PendingRequest[] = [];
  if (current.hosts.get(clientId)?.queue === queue) hosts.delete(clientId);
  for (const [requestId, entry] of pending) {
    if (entry.queue !== queue) continue;
    pending.delete(requestId);
    disconnected.push(entry);
  }
  return { state: { ...current, hosts, pending }, disconnected };
};

export const make = Effect.gen(function* UiControlBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<BrokerState>({
    hosts: new Map(),
    pending: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  const closeConnection = Effect.fn("UiControlBroker.closeConnection")(function* (
    queue: HostConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      ({ deferred }) =>
        Deferred.succeed(deferred, undelivered("The UI control host disconnected.")),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("UiControlBroker.disconnect")(function* (
    clientId: string,
    queue: HostConnection["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const removed = removeConnectionFromState(current, clientId, queue);
      return [removed.disconnected, removed.state] as const;
    });
    yield* closeConnection(queue, disconnected);
  });

  const acquireConnection = Effect.fn("UiControlBroker.acquireConnection")(function* (
    host: UiControlHost,
  ) {
    const queue = yield* Queue.dropping<UiControlStreamEvent>(HOST_QUEUE_CAPACITY);
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: HostConnection = {
      clientId: host.clientId,
      connectionId,
      environmentId: host.environmentId,
      supportedOperations: new Set(host.supportedOperations),
      focused: false,
      focusOrder: 0,
      queue,
    };
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = current.hosts.get(host.clientId);
      const removed = previousConnection
        ? removeConnectionFromState(current, host.clientId, previousConnection.queue)
        : { state: current, disconnected: [] };
      const hosts = new Map(removed.state.hosts);
      const focusSequence = removed.state.focusSequence + 1;
      hosts.set(host.clientId, { ...connection, focusOrder: focusSequence });
      return [
        { previousConnection, disconnected: removed.disconnected },
        { ...removed.state, hosts, focusSequence },
      ] as const;
    });
    if (registration.previousConnection) {
      yield* closeConnection(registration.previousConnection.queue, registration.disconnected);
    }
    return connection;
  });

  const connect: UiControlBroker["Service"]["connect"] = Effect.fn("UiControlBroker.connect")(
    (host) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.acquireRelease(acquireConnection(host), (connection) =>
            disconnect(connection.clientId, connection.queue),
          ).pipe(
            Effect.map((connection) =>
              Stream.fromQueue(connection.queue).pipe(
                Stream.filterEffect((event) => {
                  if (event.type !== "request") return Effect.succeed(true);
                  return SynchronizedRef.get(state).pipe(
                    Effect.map(
                      (current) =>
                        current.pending.get(event.request.requestId)?.queue === connection.queue,
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
  );

  const focusHost: UiControlBroker["Service"]["focusHost"] = Effect.fn("UiControlBroker.focusHost")(
    function* (host) {
      yield* SynchronizedRef.update(state, (current) => {
        const currentHost = current.hosts.get(host.clientId);
        if (
          !currentHost ||
          currentHost.environmentId !== host.environmentId ||
          currentHost.connectionId !== host.connectionId
        ) {
          return current;
        }
        const hosts = new Map(current.hosts);
        const focusSequence = host.focused ? current.focusSequence + 1 : current.focusSequence;
        hosts.set(host.clientId, {
          ...currentHost,
          focused: host.focused,
          focusOrder: host.focused ? focusSequence : currentHost.focusOrder,
        });
        return { ...current, hosts, focusSequence };
      });
    },
  );

  const respond: UiControlBroker["Service"]["respond"] = Effect.fn("UiControlBroker.respond")(
    function* (response) {
      const pending = yield* SynchronizedRef.modify(state, (current) => {
        const entry = current.pending.get(response.requestId);
        if (
          !entry ||
          entry.clientId !== response.clientId ||
          entry.connectionId !== response.connectionId
        ) {
          return [undefined, current] as const;
        }
        const next = new Map(current.pending);
        next.delete(response.requestId);
        return [entry, { ...current, pending: next }] as const;
      });
      if (!pending) return;
      yield* Deferred.succeed(
        pending.deferred,
        response.ok
          ? ({ delivered: true } as const)
          : undelivered(response.error ?? "The UI control host reported a failure."),
      );
    },
  );

  const invoke: UiControlBroker["Service"]["invoke"] = Effect.fn("UiControlBroker.invoke")(
    function* (input) {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deferred = yield* Deferred.make<UiControlInvokeResult>();
      const route = yield* SynchronizedRef.modify<BrokerState, RouteDecision>(state, (current) => {
        if (current.pending.size >= MAX_PENDING_REQUESTS) {
          return [{ type: "busy" as const }, current] as const;
        }
        const connection = Array.from(current.hosts.values())
          .filter(
            (host) =>
              host.environmentId === input.environmentId &&
              host.supportedOperations.has(input.operation),
          )
          .sort(
            (left, right) =>
              Number(right.focused) - Number(left.focused) || right.focusOrder - left.focusOrder,
          )[0];
        if (!connection) return [{ type: "missing" as const }, current] as const;
        const requestId = UiControlRequestId.make(`ui-${current.requestSequence}`);
        const pending = new Map(current.pending);
        pending.set(requestId, {
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          queue: connection.queue,
          deferred,
        });
        return [
          { type: "routed" as const, connection, requestId },
          { ...current, pending, requestSequence: current.requestSequence + 1 },
        ] as const;
      });
      if (route.type === "busy") return undelivered("The UI control host is busy.");
      if (route.type === "missing") {
        return undelivered(
          `No connected UI control host supports ${input.operation} in this environment.`,
        );
      }

      const removePending = SynchronizedRef.modify(state, (current) => {
        const entry = current.pending.get(route.requestId);
        if (!entry || entry.deferred !== deferred) return [false, current] as const;
        const pending = new Map(current.pending);
        pending.delete(route.requestId);
        return [true, { ...current, pending }] as const;
      });
      const cancelIfPending = Effect.gen(function* () {
        const removed = yield* removePending;
        if (!removed) return;
        yield* Queue.offer(route.connection.queue, {
          type: "cancel",
          connectionId: route.connection.connectionId,
          requestId: route.requestId,
        });
      }).pipe(Effect.asVoid);

      const offered = yield* Queue.offer(route.connection.queue, {
        type: "request",
        connectionId: route.connection.connectionId,
        request: {
          requestId: route.requestId,
          operation: input.operation,
          input: input.input,
        },
      });
      if (!offered) {
        yield* removePending;
        return undelivered("The UI control host is busy.");
      }

      const result = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.ensuring(cancelIfPending),
      );
      return Option.getOrElse(result, () =>
        undelivered(`The UI control host did not respond within ${timeoutMs}ms.`),
      );
    },
  );

  return UiControlBroker.of({ connect, focusHost, respond, invoke });
}).pipe(Effect.withSpan("UiControlBroker.make"));

export const layer = Layer.effect(UiControlBroker, make);
