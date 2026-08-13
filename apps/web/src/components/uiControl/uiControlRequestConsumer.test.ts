import {
  UiControlRequestId,
  type UiControlRequest,
  type UiControlResponse,
  type UiControlStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createUiControlRequestConsumerAtom,
  serializeUiControlError,
} from "./uiControlRequestConsumer";

const clientId = "client-1";
const connectionId = "connection-1";

const request = (requestId: string): UiControlRequest => ({
  requestId: UiControlRequestId.make(requestId),
  operation: "ui.revealThread",
  input: { threadId: "thread-1" },
});

const requestEvent = (
  requestId: string,
  eventConnectionId = connectionId,
): UiControlStreamEvent => ({
  type: "request",
  connectionId: eventConnectionId,
  request: request(requestId),
});

const cancelEvent = (
  requestId: string,
  eventConnectionId = connectionId,
): UiControlStreamEvent => ({
  type: "cancel",
  connectionId: eventConnectionId,
  requestId: UiControlRequestId.make(requestId),
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const mountConsumer = (options: {
  readonly requestsAtom: Atom.Writable<
    AsyncResult.AsyncResult<UiControlStreamEvent, Error>,
    AsyncResult.AsyncResult<UiControlStreamEvent, Error>
  >;
  readonly handle: (request: UiControlRequest, signal: AbortSignal) => Promise<void>;
  readonly respond: (response: UiControlResponse) => Promise<unknown>;
  readonly label: string;
}) => {
  const connectionAtom = Atom.make<string | null>(null);
  const requestHandlerAtom = Atom.make({ handle: options.handle });
  const consumerAtom = createUiControlRequestConsumerAtom({
    requestsAtom: options.requestsAtom,
    clientId,
    connectionAtom,
    requestHandlerAtom,
    respond: options.respond,
    label: options.label,
  });
  const registry = AtomRegistry.make();
  const unmount = registry.mount(consumerAtom);
  return { connectionAtom, registry, requestHandlerAtom, unmount };
};

const emptyRequestsAtom = () =>
  Atom.make<AsyncResult.AsyncResult<UiControlStreamEvent, Error>>(
    AsyncResult.initial<UiControlStreamEvent, Error>(false),
  );

describe("uiControlRequestConsumer", () => {
  it("handles a request and responds once", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<UiControlStreamEvent, Error>>(
      AsyncResult.success<UiControlStreamEvent, Error>({ type: "connected", connectionId }),
    );
    const handle = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const { connectionAtom, registry } = mountConsumer({
      requestsAtom,
      handle,
      respond,
      label: "test:ui-control-success",
    });

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-1")));
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-1")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(registry.get(connectionAtom)).toBe(connectionId);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      clientId,
      connectionId,
      requestId: "request-1",
      ok: true,
    });
    registry.dispose();
  });

  it("drops late requests from an older stream generation", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<UiControlStreamEvent, Error>>(
      AsyncResult.success<UiControlStreamEvent, Error>({
        type: "connected",
        connectionId: "connection-2",
      }),
    );
    const handle = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const { connectionAtom, registry } = mountConsumer({
      requestsAtom,
      handle,
      respond,
      label: "test:ui-control-stale-generation",
    });

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-stale", "connection-1")));

    await vi.waitFor(() => expect(registry.get(connectionAtom)).toBe("connection-2"));
    expect(handle).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("consumes synchronous events in FIFO order", async () => {
    const requestsAtom = emptyRequestsAtom();
    const first = deferred();
    const started: string[] = [];
    const responses: UiControlResponse[] = [];
    const { registry } = mountConsumer({
      requestsAtom,
      handle: async (value) => {
        started.push(value.requestId);
        if (value.requestId === "request-1") await first.promise;
      },
      respond: async (response) => {
        responses.push(response);
      },
      label: "test:ui-control-fifo",
    });

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-1")));
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-2")));

    await vi.waitFor(() => expect(started).toEqual(["request-1"]));
    expect(responses).toEqual([]);
    first.resolve();

    await vi.waitFor(() => expect(responses).toHaveLength(2));
    expect(started).toEqual(["request-1", "request-2"]);
    expect(responses.map((response) => response.requestId)).toEqual(["request-1", "request-2"]);
    registry.dispose();
  });

  it("uses an updated handler without rebuilding the consumer", async () => {
    const requestsAtom = emptyRequestsAtom();
    const firstHandler = vi.fn(async () => undefined);
    const secondHandler = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const { registry, requestHandlerAtom } = mountConsumer({
      requestsAtom,
      handle: firstHandler,
      respond,
      label: "test:ui-control-handler-update",
    });

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-1")));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    registry.set(requestHandlerAtom, { handle: secondHandler });
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-2")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it("consumes a request that arrived before the consumer mounted", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<UiControlStreamEvent, Error>>(
      AsyncResult.success<UiControlStreamEvent, Error>(requestEvent("request-ready")),
    );
    const respond = vi.fn(async () => undefined);
    const { registry } = mountConsumer({
      requestsAtom,
      handle: async () => undefined,
      respond,
      label: "test:ui-control-initial-request",
    });

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith({
      clientId,
      connectionId,
      requestId: "request-ready",
      ok: true,
    });
    registry.dispose();
  });

  it("aborts an in-flight request when the broker cancels it", async () => {
    const requestsAtom = emptyRequestsAtom();
    let requestSignal: AbortSignal | undefined;
    const respond = vi.fn(async () => undefined);
    const { registry } = mountConsumer({
      requestsAtom,
      handle: async (_value, signal) => {
        requestSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
      respond,
      label: "test:ui-control-cancel",
    });

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-cancelled")));
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    registry.set(requestsAtom, AsyncResult.success(cancelEvent("request-cancelled")));

    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("aborts pending work when the consumer unmounts", async () => {
    const requestsAtom = emptyRequestsAtom();
    let requestSignal: AbortSignal | undefined;
    const respond = vi.fn(async () => undefined);
    const { registry, unmount } = mountConsumer({
      requestsAtom,
      handle: async (_value, signal) => {
        requestSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
      respond,
      label: "test:ui-control-unmount",
    });

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-unmounted")));
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    unmount();

    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("continues after a response rejects", async () => {
    const requestsAtom = emptyRequestsAtom();
    const handle = vi.fn(async () => undefined);
    const respond = vi.fn(async () => Promise.reject(new Error("socket closed")));
    const { registry } = mountConsumer({
      requestsAtom,
      handle,
      respond,
      label: "test:ui-control-response-rejection",
    });

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-1")));
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-2")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(handle).toHaveBeenCalledTimes(2);
    registry.dispose();
  });

  it("serializes blank and non-Error failures to a stable reason", () => {
    expect(serializeUiControlError(new Error("  "))).toBe("The UI control operation failed.");
    expect(serializeUiControlError("string failure")).toBe("The UI control operation failed.");
    expect(serializeUiControlError(new Error("navigation rejected"))).toBe("navigation rejected");
  });
});
