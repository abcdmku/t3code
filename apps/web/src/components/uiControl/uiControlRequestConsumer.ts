import type {
  UiControlHost,
  UiControlRequest,
  UiControlResponse,
  UiControlStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

type UiControlStreamResult<E> = AsyncResult.AsyncResult<UiControlStreamEvent, E>;

type PendingRequest = {
  readonly connectionId: UiControlStreamEvent["connectionId"];
  readonly controller: AbortController;
};

export function serializeUiControlError(error: unknown): NonNullable<UiControlResponse["error"]> {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length > 0 ? message : "The UI control operation failed.";
}

export function createUiControlRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<UiControlStreamResult<E>>;
  readonly clientId: UiControlHost["clientId"];
  readonly connectionAtom: Atom.Writable<UiControlStreamEvent["connectionId"] | null>;
  readonly requestHandlerAtom: Atom.Atom<{
    readonly handle: (request: UiControlRequest, signal: AbortSignal) => Promise<void>;
  }>;
  readonly respond: (response: UiControlResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.connectionAtom);
    get.mount(options.requestHandlerAtom);

    let disposed = false;
    let activeConnectionId: UiControlStreamEvent["connectionId"] | null = null;
    let connectionExplicitlyAnnounced = false;
    let reportedConnectionId: UiControlStreamEvent["connectionId"] | null = null;
    let requestsVersion = 0;
    let queue = Promise.resolve();
    const handledRequests = new Set<string>();
    const pendingRequests = new Map<string, PendingRequest>();

    const requestKey = (
      connectionId: UiControlStreamEvent["connectionId"],
      requestId: UiControlRequest["requestId"],
    ) => JSON.stringify([connectionId, requestId]);

    const abortConnection = (connectionId: UiControlStreamEvent["connectionId"]) => {
      for (const pending of pendingRequests.values()) {
        if (pending.connectionId === connectionId) {
          pending.controller.abort();
        }
      }
    };

    const reportConnection = (connectionId: UiControlStreamEvent["connectionId"]) => {
      if (reportedConnectionId === connectionId) return;
      reportedConnectionId = connectionId;
      get.set(options.connectionAtom, connectionId);
    };

    const runRequest = async (
      event: Extract<UiControlStreamEvent, { readonly type: "request" }>,
      key: string,
      pending: PendingRequest,
    ) => {
      const { controller } = pending;
      if (disposed || controller.signal.aborted || activeConnectionId !== event.connectionId) {
        pendingRequests.delete(key);
        return;
      }

      let response: UiControlResponse;
      try {
        await get.once(options.requestHandlerAtom).handle(event.request, controller.signal);
        response = {
          clientId: options.clientId,
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
        };
      } catch (error) {
        response = {
          clientId: options.clientId,
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: false,
          error: serializeUiControlError(error),
        };
      }

      try {
        if (!disposed && !controller.signal.aborted && activeConnectionId === event.connectionId) {
          await options.respond(response);
        }
      } catch {
      } finally {
        pendingRequests.delete(key);
      }
    };

    const consume = (result: UiControlStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;

      if (event.type === "connected") {
        if (activeConnectionId !== null && activeConnectionId !== event.connectionId) {
          abortConnection(activeConnectionId);
        }
        activeConnectionId = event.connectionId;
        connectionExplicitlyAnnounced = true;
      } else if (activeConnectionId === null) {
        activeConnectionId = event.connectionId;
      } else if (activeConnectionId !== event.connectionId) {
        if (connectionExplicitlyAnnounced) return;
        abortConnection(activeConnectionId);
        activeConnectionId = event.connectionId;
      }

      reportConnection(event.connectionId);

      if (event.type === "connected") return;

      if (event.type === "cancel") {
        pendingRequests.get(requestKey(event.connectionId, event.requestId))?.controller.abort();
        return;
      }

      const key = requestKey(event.connectionId, event.request.requestId);
      if (handledRequests.has(key)) return;
      handledRequests.add(key);

      const pending: PendingRequest = {
        connectionId: event.connectionId,
        controller: new AbortController(),
      };
      pendingRequests.set(key, pending);
      queue = queue.then(() => runRequest(event, key, pending)).catch(() => undefined);
    };

    get.addFinalizer(() => {
      disposed = true;
      for (const pending of pendingRequests.values()) {
        pending.controller.abort();
      }
      pendingRequests.clear();
    });

    const initialResult = get.once(options.requestsAtom);
    if (AsyncResult.isSuccess(initialResult)) {
      activeConnectionId = initialResult.value.connectionId;
      connectionExplicitlyAnnounced = initialResult.value.type === "connected";
      if (initialResult.value.type === "connected") {
        reportConnection(initialResult.value.connectionId);
      }
    }

    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });

    queueMicrotask(() => {
      const initialConnectionWasSkipped =
        AsyncResult.isSuccess(initialResult) &&
        initialResult.value.connectionId === activeConnectionId &&
        initialResult.value.connectionId !== reportedConnectionId;
      if (!disposed && (requestsVersion === 0 || initialConnectionWasSkipped)) {
        consume(initialResult);
      }
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
