import { describe, expect, it } from "@effect/vitest";
import { ORCHESTRATION_WS_METHODS, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { layer } from "./Client.ts";
import { T3AuthError, T3ConfigError, T3InputError, T3TransportError } from "./errors.ts";
import { createT3Client } from "./promise.ts";
import { createT3ClientFromLayer } from "./promiseClient.ts";
import { T3WsConnector, type T3WsConnect, type T3WsRpcClient } from "./ws.ts";

const isT3AuthError = (value: unknown): value is T3AuthError => value instanceof T3AuthError;
const isT3TransportError = (value: unknown): value is T3TransportError =>
  value instanceof T3TransportError;
const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const BASE_URL = "http://127.0.0.1:5273";
const ISO = "2026-05-01T12:00:00.000Z";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const descriptorJson = {
  environmentId: "environment-1",
  label: "Local environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.31",
  capabilities: { repositoryIdentity: true },
};

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    if (!response) {
      return Promise.reject(new Error("Unexpected fetch call"));
    }
    return Promise.resolve(response);
  }) satisfies typeof fetch;
  return { fetchFn, calls };
};

const bodyText = (init: RequestInit): string => {
  const body = init.body;
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  throw new Error("Expected a fetch request body");
};

describe("promise facade", () => {
  it("rejects invalid configuration with T3ConfigError", async () => {
    const client = createT3Client({ baseUrl: "not a URL" });
    try {
      await expect(client.descriptor()).rejects.toBeInstanceOf(T3ConfigError);
    } finally {
      await client.close();
    }
  });

  it("rejects empty request IDs before sending a request", async () => {
    const fetch = recordedFetch();
    const client = createT3Client({ baseUrl: BASE_URL, fetch: fetch.fetchFn });
    try {
      await expect(client.archiveThread({ threadId: "" })).rejects.toBeInstanceOf(T3InputError);
      const iterator = client.subscribeThread("")[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toBeInstanceOf(T3InputError);
      expect(fetch.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("settles the first stream pull when the WebSocket constructor throws", async () => {
    const fetch = recordedFetch(
      Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
    );
    const client = createT3Client({
      baseUrl: BASE_URL,
      fetch: fetch.fetchFn,
      webSocket: () => {
        throw new Error("constructor failed");
      },
      resubscribeDelayMs: 0,
    });
    try {
      const iterator = client.subscribeShell()[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toBeInstanceOf(T3TransportError);
      expect(fetch.calls).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("resolves plain promises without exposing Effect types", async () => {
    const fetch = recordedFetch(Response.json(descriptorJson), Response.json({ sequence: 3 }));
    const client = createT3Client({
      baseUrl: BASE_URL,
      fetch: fetch.fetchFn,
      auth: { type: "bearer", token: "token-1" },
    });
    try {
      const descriptor = await client.descriptor();
      expect(descriptor.environmentId).toBe("environment-1");

      const result = await client.archiveThread({ threadId: ThreadId.make("thread-1") });
      expect(result).toEqual({ sequence: 3 });

      const dispatchCall = fetch.calls[1];
      expect(dispatchCall).toBeDefined();
      if (dispatchCall) {
        const body = decodeJsonBody(bodyText(dispatchCall[1])) as {
          readonly type: string;
          readonly commandId: string;
        };
        expect(body.type).toBe("thread.archive");
        expect(body.commandId).toMatch(UUID_PATTERN);
      }
    } finally {
      await client.close();
    }
  });

  it("rejects with the typed error classes", async () => {
    const fetch = recordedFetch(
      Response.json(
        {
          _tag: "EnvironmentAuthInvalidError",
          code: "auth_invalid",
          reason: "missing_credential",
          traceId: "trace-1",
        },
        { status: 401 },
      ),
    );
    const client = createT3Client({ baseUrl: BASE_URL, fetch: fetch.fetchFn });
    try {
      const error: unknown = await client.shell().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(isT3AuthError(error)).toBe(true);
      if (isT3AuthError(error)) {
        expect(error.reason).toBe("missing_credential");
      }
    } finally {
      await client.close();
    }
  });

  it("exposes subscriptions as async iterables", async () => {
    const fetch = recordedFetch(
      Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
    );
    const shellItems = [
      {
        kind: "snapshot" as const,
        snapshot: { snapshotSequence: 1, projects: [], threads: [], updatedAt: ISO },
      },
      {
        kind: "thread-removed" as const,
        sequence: 2,
        threadId: ThreadId.make("thread-2"),
      },
    ];
    const connect: T3WsConnect = () =>
      Effect.succeed({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromArray(shellItems),
      } as unknown as T3WsRpcClient);
    const client = createT3ClientFromLayer(
      layer({
        baseUrl: BASE_URL,
        fetch: fetch.fetchFn,
        auth: { type: "bearer", token: "token-1" },
      }).pipe(Layer.provide(Layer.succeed(T3WsConnector, connect))),
    );
    try {
      const collected: Array<unknown> = [];
      for await (const item of client.subscribeShell()) {
        collected.push(item);
      }
      expect(collected).toEqual(shellItems);
    } finally {
      await client.close();
    }
  });

  it("close() interrupts active subscriptions and releases their resources", async () => {
    const fetch = recordedFetch(
      Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
    );
    const shellItems = [
      {
        kind: "snapshot" as const,
        snapshot: { snapshotSequence: 1, projects: [], threads: [], updatedAt: ISO },
      },
      {
        kind: "thread-removed" as const,
        sequence: 2,
        threadId: ThreadId.make("thread-2"),
      },
    ];
    let released = false;
    // A subscription that never completes on its own: only close() can end it.
    const connect: T3WsConnect = () =>
      Effect.acquireRelease(
        Effect.succeed({
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.fromArray(shellItems).pipe(Stream.concat(Stream.never)),
        } as unknown as T3WsRpcClient),
        () =>
          Effect.sync(() => {
            released = true;
          }),
      );
    const client = createT3ClientFromLayer(
      layer({
        baseUrl: BASE_URL,
        fetch: fetch.fetchFn,
        auth: { type: "bearer", token: "token-1" },
      }).pipe(Layer.provide(Layer.succeed(T3WsConnector, connect))),
    );

    const iterator = client.subscribeShell()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: shellItems[0] });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: shellItems[1] });

    await client.close();

    expect(released).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not emit an item that resolves after close starts", async () => {
    const fetch = recordedFetch(
      Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
    );
    let releaseItem!: () => void;
    const itemGate = new Promise<void>((resolve) => {
      releaseItem = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const item = {
      kind: "snapshot" as const,
      snapshot: { snapshotSequence: 1, projects: [], threads: [], updatedAt: ISO },
    };
    const connect: T3WsConnect = () =>
      Effect.succeed({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
          Stream.fromEffect(
            Effect.promise(async () => {
              markStarted();
              await itemGate;
              return item;
            }),
          ),
      } as unknown as T3WsRpcClient);
    const client = createT3ClientFromLayer(
      layer({ baseUrl: BASE_URL, fetch: fetch.fetchFn }).pipe(
        Layer.provide(Layer.succeed(T3WsConnector, connect)),
      ),
    );

    const iterator = client.subscribeShell()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await started;
    const closed = client.close();
    releaseItem();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await closed;
  });

  it("converts a typed stream failure racing close() into { done: true }", async () => {
    const fetch = recordedFetch(
      Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
    );
    const firstItem = {
      kind: "snapshot" as const,
      snapshot: { snapshotSequence: 1, projects: [], threads: [], updatedAt: ISO },
    };
    // A T3AuthError classifies as fail-fast (unlike T3TransportError, which
    // the client resubscribes on), so it reaches the facade iterator typed.
    const failure = new T3AuthError({ message: "session revoked", reason: "insufficient_scope" });
    // Emits one item, then fails with a typed error on the next pull.
    const connect: T3WsConnect = () =>
      Effect.succeed({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
          Stream.fromArray([firstItem]).pipe(
            Stream.concat(Stream.fromEffect(Effect.fail(failure))),
          ),
      } as unknown as T3WsRpcClient);
    const client = createT3ClientFromLayer(
      layer({
        baseUrl: BASE_URL,
        fetch: fetch.fetchFn,
        auth: { type: "bearer", token: "token-1" },
      }).pipe(Layer.provide(Layer.succeed(T3WsConnector, connect))),
    );

    const iterator = client.subscribeShell()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: firstItem });

    // Start the next() that pulls the failure, then begin closing in the
    // same tick. The pull fiber captures the typed failure before close()'s
    // interrupt can land, so the underlying next() rejects typed while
    // `closing` is already set. The consumer must still see { done: true }.
    const pending = iterator.next();
    const closed = client.close();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await closed;
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("still rejects typed errors from a failing stream when the client is not closing", async () => {
    const fetch = recordedFetch(
      Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
    );
    const firstItem = {
      kind: "snapshot" as const,
      snapshot: { snapshotSequence: 1, projects: [], threads: [], updatedAt: ISO },
    };
    // Fail-fast classification: auth errors are never retried, so the typed
    // error must reach the consumer unchanged.
    const failure = new T3AuthError({ message: "session revoked", reason: "insufficient_scope" });
    const connect: T3WsConnect = () =>
      Effect.succeed({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
          Stream.fromArray([firstItem]).pipe(
            Stream.concat(Stream.fromEffect(Effect.fail(failure))),
          ),
      } as unknown as T3WsRpcClient);
    const client = createT3ClientFromLayer(
      layer({
        baseUrl: BASE_URL,
        fetch: fetch.fetchFn,
        auth: { type: "bearer", token: "token-1" },
      }).pipe(Layer.provide(Layer.succeed(T3WsConnector, connect))),
    );
    try {
      const iterator = client.subscribeShell()[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ done: false, value: firstItem });

      const error: unknown = await iterator.next().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(isT3AuthError(error)).toBe(true);
      if (isT3AuthError(error)) {
        expect(error.reason).toBe("insufficient_scope");
      }
    } finally {
      await client.close();
    }
  });

  // `it.live` so Effect.sleep below runs on the real clock; the promise
  // facade under test never sees the Effect runtime the test itself uses.
  it.live("close() resolves only after an in-flight return()'s cleanup completes", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "ticket-1", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      const firstItem = {
        kind: "snapshot" as const,
        snapshot: { snapshotSequence: 1, projects: [], threads: [], updatedAt: ISO },
      };
      const order: Array<string> = [];
      let releaseNow!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        releaseNow = resolve;
      });
      // The subscription's finalizer cannot finish until the gate opens.
      const connect: T3WsConnect = () =>
        Effect.acquireRelease(
          Effect.succeed({
            [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
              Stream.fromArray([firstItem]).pipe(Stream.concat(Stream.never)),
          } as unknown as T3WsRpcClient),
          () =>
            Effect.promise(async () => {
              await releaseGate;
              order.push("released");
            }),
        );
      const client = createT3ClientFromLayer(
        layer({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "bearer", token: "token-1" },
        }).pipe(Layer.provide(Layer.succeed(T3WsConnector, connect))),
      );

      const iterator = client.subscribeShell()[Symbol.asyncIterator]();
      const first = yield* Effect.promise(() => iterator.next());
      expect(first).toEqual({ done: false, value: firstItem });

      const returned = iterator.return?.();
      expect(returned).toBeDefined();
      const closed = client.close().then(() => {
        order.push("closed");
      });

      // close() must not settle while the return()'s finalizer is still gated.
      yield* Effect.sleep("25 millis");
      expect(order).toEqual([]);

      releaseNow();
      yield* Effect.promise(() => Promise.all([returned, closed]));
      expect(order).toEqual(["released", "closed"]);
    }),
  );

  it("resolves { done: true } for an iterator closed before its first next()", async () => {
    const fetch = recordedFetch();
    const client = createT3Client({
      baseUrl: BASE_URL,
      fetch: fetch.fetchFn,
      auth: { type: "bearer", token: "token-1" },
    });

    const iterator = client.subscribeShell()[Symbol.asyncIterator]();
    await client.close();

    // The iterator never touched the (now disposed) runtime: it ends
    // instead of rejecting, and no request was ever issued.
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    expect(fetch.calls).toHaveLength(0);
  });

  it("ends subscriptions requested after close() without touching the runtime", async () => {
    const fetch = recordedFetch();
    const client = createT3Client({
      baseUrl: BASE_URL,
      fetch: fetch.fetchFn,
      auth: { type: "bearer", token: "token-1" },
    });
    await client.close();

    const iterator = client.subscribeShell()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects method calls after close() with a typed client-closed error", async () => {
    const fetch = recordedFetch();
    const client = createT3Client({
      baseUrl: BASE_URL,
      fetch: fetch.fetchFn,
      auth: { type: "bearer", token: "token-1" },
    });
    await client.close();
    // close() is idempotent and keeps resolving after the first call.
    await client.close();

    const error: unknown = await client.shell().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(isT3TransportError(error)).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });
});
