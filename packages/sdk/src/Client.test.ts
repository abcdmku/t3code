import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type OrchestrationShellStreamItem,
  type OrchestrationSubscribeShellInput,
  type OrchestrationSubscribeThreadInput,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { layer, T3Client, type T3AccessToken, type T3ClientConfig } from "./Client.ts";
import { T3AuthError, T3DecodeError, T3RequestError, T3TokenPersistenceError } from "./errors.ts";
import { T3WsConnector, type T3WsConnect, type T3WsRpcClient } from "./ws.ts";

const isT3AuthError = (value: unknown): value is T3AuthError => value instanceof T3AuthError;
const isT3DecodeError = (value: unknown): value is T3DecodeError => value instanceof T3DecodeError;
const isT3RequestError = (value: unknown): value is T3RequestError =>
  value instanceof T3RequestError;
const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const BASE_URL = "http://127.0.0.1:5273";
const ISO = "2026-05-01T12:00:00.000Z";
// it.effect runs under TestClock, so stamped timestamps are the virtual epoch.
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: Array<FetchCall> = [];
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

const expectFetchCall = (
  calls: ReadonlyArray<FetchCall>,
  index: number,
  expected: {
    readonly url: string;
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): void => {
  const call = calls[index - 1];
  expect(call).toBeDefined();
  if (!call) {
    return;
  }
  const [url, init] = call;
  expect(String(url)).toBe(expected.url);
  expect(init).toEqual(expect.objectContaining({ method: expected.method }));
  expect(init.headers).toEqual(expect.objectContaining(expected.headers ?? {}));
  if ("body" in expected) {
    expect(bodyText(init)).toBe(expected.body);
  }
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

const descriptorJson = {
  environmentId: "environment-1",
  label: "Local environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.31",
  capabilities: { repositoryIdentity: true, threadSettlement: true },
};

const shellSnapshotJson = {
  snapshotSequence: 4,
  projects: [],
  threads: [],
  updatedAt: ISO,
};

const threadDetailJson = {
  snapshotSequence: 9,
  thread: {
    id: "thread-9",
    projectId: "project-1",
    title: "Sketch guesses",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  },
};

const accessTokenJson = {
  access_token: "access-token-1",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "orchestration:read",
};

const ticketJson = (ticket: string) => ({ ticket, expiresAt: "2026-05-01T12:05:00.000Z" });

const provideClient = (config: T3ClientConfig, wsConnect?: T3WsConnect) =>
  Effect.provide(
    wsConnect === undefined
      ? layer(config)
      : layer(config).pipe(Layer.provide(Layer.succeed(T3WsConnector, wsConnect))),
  );

describe("T3Client HTTP methods", () => {
  it.effect("decodes the well-known descriptor and exposes capability flags", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(descriptorJson));
      const descriptor = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* client.descriptor;
      }).pipe(provideClient({ baseUrl: BASE_URL, fetch: fetch.fetchFn }));

      expect(descriptor).toMatchObject({
        environmentId: "environment-1",
        capabilities: { repositoryIdentity: true, threadSettlement: true },
      });
      expect(descriptor.capabilities.threadSnooze).toBeUndefined();
      expectFetchCall(fetch.calls, 1, {
        url: `${BASE_URL}/.well-known/t3/environment`,
        method: "GET",
      });
    }),
  );

  it.effect("injects the configured bearer token on orchestration reads", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(shellSnapshotJson));
      const shell = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* client.shell;
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "bearer", token: "token-1" },
        }),
      );

      expect(shell.snapshotSequence).toBe(4);
      expectFetchCall(fetch.calls, 1, {
        url: `${BASE_URL}/api/orchestration/shell`,
        method: "GET",
        headers: { authorization: "Bearer token-1" },
      });
    }),
  );

  it.effect("exchanges a pairing credential once and reuses the access token", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(accessTokenJson),
        Response.json(shellSnapshotJson),
        Response.json(threadDetailJson),
      );
      yield* Effect.gen(function* () {
        const client = yield* T3Client;
        yield* client.shell;
        const detail = yield* client.thread(ThreadId.make("thread-9"));
        expect(detail.thread.id).toBe("thread-9");
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: {
            type: "pairing",
            credential: "pairing-credential-1",
            scopes: ["orchestration:read"],
          },
        }),
      );

      expect(fetch.calls).toHaveLength(3);
      expectFetchCall(fetch.calls, 1, {
        url: `${BASE_URL}/oauth/token`,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=pairing-credential-1&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&scope=orchestration%3Aread",
      });
      expectFetchCall(fetch.calls, 2, {
        url: `${BASE_URL}/api/orchestration/shell`,
        method: "GET",
        headers: { authorization: "Bearer access-token-1" },
      });
      expectFetchCall(fetch.calls, 3, {
        url: `${BASE_URL}/api/orchestration/threads/thread-9`,
        method: "GET",
        headers: { authorization: "Bearer access-token-1" },
      });
    }),
  );

  it.effect("hands the full pairing exchange result to onToken", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(accessTokenJson), Response.json(shellSnapshotJson));
      const tokens: Array<T3AccessToken> = [];
      yield* Effect.gen(function* () {
        const client = yield* T3Client;
        yield* client.shell;
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "pairing", credential: "pairing-credential-1" },
          onToken: (token) => {
            tokens.push(token);
          },
        }),
      );

      // it.effect runs at the TestClock epoch, so expiry is exactly expires_in.
      expect(tokens).toEqual([
        {
          accessToken: "access-token-1",
          expiresAt: 3_600_000,
          scope: "orchestration:read",
          tokenType: "Bearer",
        },
      ]);
    }),
  );

  it.effect("fails the request when token persistence fails, then retries the save", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(accessTokenJson), Response.json(shellSnapshotJson));
      let onTokenCalls = 0;
      yield* Effect.gen(function* () {
        const client = yield* T3Client;
        const firstError = yield* Effect.flip(client.shell);
        expect(firstError).toBeInstanceOf(T3TokenPersistenceError);
        const shell = yield* client.shell;
        expect(shell.snapshotSequence).toBe(4);
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "pairing", credential: "pairing-credential-1" },
          onToken: () => {
            onTokenCalls += 1;
            if (onTokenCalls === 1) {
              throw new Error("persistence failed");
            }
          },
        }),
      );

      expect(onTokenCalls).toBe(2);
      expect(fetch.calls).toHaveLength(2);
      expectFetchCall(fetch.calls, 1, { url: `${BASE_URL}/oauth/token`, method: "POST" });
      expectFetchCall(fetch.calls, 2, {
        url: `${BASE_URL}/api/orchestration/shell`,
        method: "GET",
        headers: { authorization: "Bearer access-token-1" },
      });
    }),
  );

  it.effect("maps an async token persistence rejection to a typed error", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(accessTokenJson));
      let onTokenCalls = 0;
      const error = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* client.shell;
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "pairing", credential: "pairing-credential-1" },
          onToken: async () => {
            onTokenCalls += 1;
            return Promise.reject(new Error("async persistence failed"));
          },
        }),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(T3TokenPersistenceError);
      expect(onTokenCalls).toBe(1);
      expect(fetch.calls).toHaveLength(1);
    }),
  );

  it.effect("reuses a persisted pairing token instead of re-exchanging the credential", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(shellSnapshotJson));
      yield* Effect.gen(function* () {
        const client = yield* T3Client;
        yield* client.shell;
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: {
            type: "pairing",
            credential: "pairing-credential-1",
            token: {
              accessToken: "restored-token",
              expiresAt: 60_000,
              scope: "orchestration:read",
              tokenType: "Bearer",
            },
          },
        }),
      );

      expect(fetch.calls).toHaveLength(1);
      expectFetchCall(fetch.calls, 1, {
        url: `${BASE_URL}/api/orchestration/shell`,
        method: "GET",
        headers: { authorization: "Bearer restored-token" },
      });
    }),
  );

  it.effect("fails with token_expired once the exchanged token passes its expiry", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(accessTokenJson), Response.json(shellSnapshotJson));
      const error = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        yield* client.shell;
        yield* TestClock.adjust(Duration.hours(2));
        return yield* Effect.flip(client.shell);
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "pairing", credential: "pairing-credential-1" },
        }),
      );

      expect(isT3AuthError(error)).toBe(true);
      if (isT3AuthError(error)) {
        expect(error.reason).toBe("token_expired");
      }
      // The single-use credential is never exchanged a second time.
      expect(fetch.calls).toHaveLength(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("authenticates with a standalone persisted token without any exchange", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(shellSnapshotJson));
      yield* Effect.gen(function* () {
        const client = yield* T3Client;
        yield* client.shell;
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: {
            type: "token",
            token: {
              accessToken: "restored-token",
              expiresAt: 60_000,
              scope: "orchestration:read",
              tokenType: "Bearer",
            },
          },
        }),
      );

      // The only request is the read itself: no exchange, no credential.
      expect(fetch.calls).toHaveLength(1);
      expectFetchCall(fetch.calls, 1, {
        url: `${BASE_URL}/api/orchestration/shell`,
        method: "GET",
        headers: { authorization: "Bearer restored-token" },
      });
    }),
  );

  it.effect("rejects an expired standalone persisted token without any request", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch();
      const error = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* Effect.flip(client.shell);
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: {
            type: "token",
            token: {
              accessToken: "stale-token",
              expiresAt: 0,
              scope: "orchestration:read",
              tokenType: "Bearer",
            },
          },
        }),
      );

      expect(isT3AuthError(error)).toBe(true);
      if (isT3AuthError(error)) {
        expect(error.reason).toBe("token_expired");
      }
      // No exchange is possible without a credential, so nothing is fetched.
      expect(fetch.calls).toHaveLength(0);
    }),
  );

  it.effect(
    "falls back to exchanging the credential when the persisted pairing token expired",
    () =>
      Effect.gen(function* () {
        const fetch = recordedFetch(
          Response.json(accessTokenJson),
          Response.json(shellSnapshotJson),
        );
        yield* Effect.gen(function* () {
          const client = yield* T3Client;
          yield* client.shell;
        }).pipe(
          provideClient({
            baseUrl: BASE_URL,
            fetch: fetch.fetchFn,
            auth: {
              type: "pairing",
              credential: "fresh-pairing-credential",
              token: {
                accessToken: "stale-token",
                expiresAt: 0,
                scope: "orchestration:read",
                tokenType: "Bearer",
              },
            },
          }),
        );

        expect(fetch.calls).toHaveLength(2);
        expectFetchCall(fetch.calls, 1, { url: `${BASE_URL}/oauth/token`, method: "POST" });
        expectFetchCall(fetch.calls, 2, {
          url: `${BASE_URL}/api/orchestration/shell`,
          method: "GET",
          headers: { authorization: "Bearer access-token-1" },
        });
      }),
  );

  it.effect("fills dispatch boilerplate before the command crosses the wire", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json({ sequence: 12 }));
      const result = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* client.dispatch({
          type: "thread.turn.start",
          threadId: ThreadId.make("thread-1"),
          message: { text: "guess!" },
        });
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "bearer", token: "token-1" },
        }),
      );

      expect(result).toEqual({ sequence: 12 });
      expectFetchCall(fetch.calls, 1, {
        url: `${BASE_URL}/api/orchestration/dispatch`,
        method: "POST",
        headers: { authorization: "Bearer token-1" },
      });
      const call = fetch.calls[0];
      expect(call).toBeDefined();
      if (!call) {
        return;
      }
      const body = decodeJsonBody(bodyText(call[1])) as {
        readonly type: string;
        readonly commandId: string;
        readonly createdAt: string;
        readonly runtimeMode: string;
        readonly interactionMode: string;
        readonly message: {
          readonly messageId: string;
          readonly role: string;
          readonly attachments: ReadonlyArray<unknown>;
        };
      };
      expect(body).toMatchObject({
        type: "thread.turn.start",
        createdAt: EPOCH_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        message: { role: "user", attachments: [] },
      });
      expect(body.commandId).toMatch(UUID_PATTERN);
      expect(body.message.messageId).toMatch(UUID_PATTERN);
    }),
  );

  it.effect("maps auth rejections to T3AuthError", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-auth",
          },
          { status: 401 },
        ),
      );
      const error = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* client.shell;
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "bearer", token: "expired" },
        }),
        Effect.flip,
      );

      expect(isT3AuthError(error)).toBe(true);
      if (isT3AuthError(error)) {
        expect(error.reason).toBe("invalid_credential");
        expect(error.traceId).toBe("trace-auth");
      }
    }),
  );

  it.effect("surfaces missing scopes as T3AuthError with the required scope", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            _tag: "EnvironmentScopeRequiredError",
            code: "insufficient_scope",
            requiredScope: "orchestration:operate",
            traceId: "trace-scope",
          },
          { status: 403 },
        ),
      );
      const error = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* client.dispatch({
          type: "thread.archive",
          threadId: ThreadId.make("thread-1"),
        });
      }).pipe(
        provideClient({
          baseUrl: BASE_URL,
          fetch: fetch.fetchFn,
          auth: { type: "bearer", token: "read-only" },
        }),
        Effect.flip,
      );

      expect(isT3AuthError(error)).toBe(true);
      if (isT3AuthError(error)) {
        expect(error.requiredScope).toBe("orchestration:operate");
        expect(error.traceId).toBe("trace-scope");
      }
    }),
  );
});

const shellSnapshotItem = (sequence: number): OrchestrationShellStreamItem => ({
  kind: "snapshot",
  snapshot: { snapshotSequence: sequence, projects: [], threads: [], updatedAt: ISO },
});

const shellEventItem = (sequence: number): OrchestrationShellStreamItem => ({
  kind: "thread-removed",
  sequence,
  threadId: ThreadId.make(`thread-${sequence}`),
});

const threadEventItem = (sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: ISO,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.archived",
    payload: { threadId: ThreadId.make("thread-1"), archivedAt: ISO, updatedAt: ISO },
  },
});

const transportLoss = () =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketCloseError({ code: 1006, closeReason: "socket closed" }),
  });

const protocolDefect = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "malformed frame",
      cause: new Error("malformed frame"),
    }),
  });

interface StubWsHandlers {
  readonly subscribeShell?: (
    input: OrchestrationSubscribeShellInput,
  ) => Stream.Stream<OrchestrationShellStreamItem, unknown>;
  readonly subscribeThread?: (
    input: OrchestrationSubscribeThreadInput,
  ) => Stream.Stream<OrchestrationThreadStreamItem, unknown>;
}

const stubConnector = (handlers: StubWsHandlers) => {
  const socketUrls: Array<string> = [];
  const connect: T3WsConnect = (options) =>
    Effect.sync(() => {
      socketUrls.push(options.socketUrl);
      return {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: handlers.subscribeShell,
        [ORCHESTRATION_WS_METHODS.subscribeThread]: handlers.subscribeThread,
      } as unknown as T3WsRpcClient;
    });
  return { connect, socketUrls };
};

describe("T3Client subscriptions", () => {
  it.effect(
    "subscribes over a ticketed websocket and resumes with afterSequence after transport loss",
    () =>
      Effect.gen(function* () {
        const fetch = recordedFetch(
          Response.json(ticketJson("ticket-1")),
          Response.json(ticketJson("ticket-2")),
        );
        const inputs: Array<OrchestrationSubscribeShellInput> = [];
        const { connect, socketUrls } = stubConnector({
          subscribeShell: (input) => {
            inputs.push(input);
            return inputs.length === 1
              ? Stream.make(shellSnapshotItem(5), shellEventItem(6)).pipe(
                  Stream.concat(Stream.fail(transportLoss())),
                )
              : Stream.make(shellEventItem(6), shellEventItem(7));
          },
        });

        const items = yield* Effect.gen(function* () {
          const client = yield* T3Client;
          return yield* Stream.runCollect(Stream.take(client.subscribeShell, 3));
        }).pipe(
          provideClient(
            {
              baseUrl: BASE_URL,
              fetch: fetch.fetchFn,
              auth: { type: "bearer", token: "token-1" },
              resubscribeDelayMs: 0,
            },
            connect,
          ),
        );

        expect(items).toEqual([shellSnapshotItem(5), shellEventItem(6), shellEventItem(7)]);
        expect(inputs).toEqual([{}, { afterSequence: 6 }]);
        expect(socketUrls).toEqual([
          `ws://127.0.0.1:5273/ws?wsTicket=ticket-1`,
          `ws://127.0.0.1:5273/ws?wsTicket=ticket-2`,
        ]);
        expectFetchCall(fetch.calls, 1, {
          url: `${BASE_URL}/api/auth/websocket-ticket`,
          method: "POST",
          headers: { authorization: "Bearer token-1" },
        });
        expectFetchCall(fetch.calls, 2, {
          url: `${BASE_URL}/api/auth/websocket-ticket`,
          method: "POST",
          headers: { authorization: "Bearer token-1" },
        });
      }),
  );

  it.effect("does not move the resume cursor backward after a replayed snapshot", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(ticketJson("ticket-1")),
        Response.json(ticketJson("ticket-2")),
        Response.json(ticketJson("ticket-3")),
      );
      const inputs: Array<OrchestrationSubscribeShellInput> = [];
      const { connect } = stubConnector({
        subscribeShell: (input) => {
          inputs.push(input);
          if (inputs.length === 1) {
            return Stream.make(shellSnapshotItem(5), shellEventItem(6)).pipe(
              Stream.concat(Stream.fail(transportLoss())),
            );
          }
          if (inputs.length === 2) {
            return Stream.make(shellSnapshotItem(2), shellEventItem(4)).pipe(
              Stream.concat(Stream.fail(transportLoss())),
            );
          }
          return Stream.make(shellEventItem(7));
        },
      });

      const items = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* Stream.runCollect(Stream.take(client.subscribeShell, 4));
      }).pipe(
        provideClient(
          {
            baseUrl: BASE_URL,
            fetch: fetch.fetchFn,
            auth: { type: "bearer", token: "token-1" },
            resubscribeDelayMs: 0,
          },
          connect,
        ),
      );

      expect(items).toEqual([
        shellSnapshotItem(5),
        shellEventItem(6),
        shellSnapshotItem(2),
        shellEventItem(7),
      ]);
      expect(inputs).toEqual([{}, { afterSequence: 6 }, { afterSequence: 6 }]);
    }),
  );

  it.effect("resumes a thread subscription from the last seen event sequence", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(ticketJson("ticket-1")),
        Response.json(ticketJson("ticket-2")),
      );
      const inputs: Array<OrchestrationSubscribeThreadInput> = [];
      const { connect } = stubConnector({
        subscribeThread: (input) => {
          inputs.push(input);
          return inputs.length === 1
            ? Stream.make(threadEventItem(11)).pipe(Stream.concat(Stream.fail(transportLoss())))
            : Stream.make(threadEventItem(11), threadEventItem(12));
        },
      });

      const items = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* Stream.runCollect(
          Stream.take(client.subscribeThread(ThreadId.make("thread-1")), 2),
        );
      }).pipe(
        provideClient(
          {
            baseUrl: BASE_URL,
            fetch: fetch.fetchFn,
            auth: { type: "bearer", token: "token-1" },
            resubscribeDelayMs: 0,
          },
          connect,
        ),
      );

      expect(items).toEqual([threadEventItem(11), threadEventItem(12)]);
      expect(inputs).toEqual([
        { threadId: "thread-1" },
        { threadId: "thread-1", afterSequence: 11 },
      ]);
    }),
  );

  it.effect("fails the subscription on typed server errors instead of reconnecting", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(ticketJson("ticket-1")));
      const { connect } = stubConnector({
        subscribeShell: () =>
          Stream.fail(
            new EnvironmentAuthorizationError({
              message: "Subscription requires orchestration:read.",
              requiredScope: "orchestration:read",
            }),
          ),
      });

      const error = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* Stream.runCollect(client.subscribeShell);
      }).pipe(
        provideClient(
          {
            baseUrl: BASE_URL,
            fetch: fetch.fetchFn,
            auth: { type: "bearer", token: "token-1" },
            resubscribeDelayMs: 0,
          },
          connect,
        ),
        Effect.flip,
      );

      expect(isT3AuthError(error)).toBe(true);
      if (isT3AuthError(error)) {
        expect(error.requiredScope).toBe("orchestration:read");
      }
      expect(isT3RequestError(error)).toBe(false);
    }),
  );

  it.effect("retries the ticket fetch after a transient transport failure", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;
      const fetchFn = (() => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? Promise.reject(new Error("network down"))
          : Promise.resolve(Response.json(ticketJson(`ticket-${fetchCalls}`)));
      }) satisfies typeof fetch;
      const { connect, socketUrls } = stubConnector({
        subscribeShell: () => Stream.make(shellSnapshotItem(1)),
      });

      const items = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* Stream.runCollect(Stream.take(client.subscribeShell, 1));
      }).pipe(
        provideClient(
          {
            baseUrl: BASE_URL,
            fetch: fetchFn,
            auth: { type: "bearer", token: "token-1" },
            resubscribeDelayMs: 0,
          },
          connect,
        ),
      );

      expect(items).toEqual([shellSnapshotItem(1)]);
      expect(fetchCalls).toBe(2);
      expect(socketUrls).toEqual([`ws://127.0.0.1:5273/ws?wsTicket=ticket-2`]);
    }),
  );

  it.effect("fails with T3DecodeError on protocol defects instead of reconnecting", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(ticketJson("ticket-1")));
      const { connect, socketUrls } = stubConnector({
        subscribeShell: () => Stream.fail(protocolDefect()),
      });

      const error = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* Stream.runCollect(client.subscribeShell);
      }).pipe(
        provideClient(
          {
            baseUrl: BASE_URL,
            fetch: fetch.fetchFn,
            auth: { type: "bearer", token: "token-1" },
            resubscribeDelayMs: 0,
          },
          connect,
        ),
        Effect.flip,
      );

      expect(isT3DecodeError(error)).toBe(true);
      expect(socketUrls).toHaveLength(1);
      expect(fetch.calls).toHaveLength(1);
    }),
  );

  it.effect("backs off from resubscribeDelayMs and doubles it per consecutive failure", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(ticketJson("ticket-1")),
        Response.json(ticketJson("ticket-2")),
        Response.json(ticketJson("ticket-3")),
      );
      const attemptFailed = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      let attempts = 0;
      const { connect } = stubConnector({
        subscribeShell: () => {
          attempts += 1;
          const failed = attemptFailed[attempts - 1];
          return failed === undefined
            ? Stream.make(shellSnapshotItem(1))
            : Stream.fromEffect(Deferred.succeed(failed, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.fail(transportLoss())),
              );
        },
      });

      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const client = yield* T3Client;
          return yield* Stream.runCollect(Stream.take(client.subscribeShell, 1));
        }).pipe(
          provideClient(
            {
              baseUrl: BASE_URL,
              fetch: fetch.fetchFn,
              auth: { type: "bearer", token: "token-1" },
              resubscribeDelayMs: 1_000,
            },
            connect,
          ),
        ),
      );

      yield* Deferred.await(attemptFailed[0]!);
      expect(attempts).toBe(1);
      // The virtual clock proves the wait: nothing reconnects before the base
      // delay elapses...
      yield* TestClock.adjust(Duration.millis(999));
      expect(attempts).toBe(1);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(attemptFailed[1]!);
      expect(attempts).toBe(2);
      // ...and the second consecutive failure doubles the delay.
      yield* TestClock.adjust(Duration.millis(1_999));
      expect(attempts).toBe(2);
      yield* TestClock.adjust(Duration.millis(1));
      const items = yield* Fiber.join(fiber);
      expect(attempts).toBe(3);
      expect(items).toEqual([shellSnapshotItem(1)]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases each connection attempt's resources before the next attempt", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(ticketJson("ticket-1")),
        Response.json(ticketJson("ticket-2")),
      );
      const events: Array<string> = [];
      let connections = 0;
      const connect: T3WsConnect = () =>
        Effect.gen(function* () {
          connections += 1;
          const id = connections;
          yield* Effect.acquireRelease(
            Effect.sync(() => events.push(`open-${id}`)),
            () => Effect.sync(() => void events.push(`close-${id}`)),
          );
          return {
            [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
              id === 1
                ? Stream.make(shellSnapshotItem(5), shellEventItem(6)).pipe(
                    Stream.concat(Stream.fail(transportLoss())),
                  )
                : Stream.make(shellEventItem(7)),
          } as unknown as T3WsRpcClient;
        });

      const items = yield* Effect.gen(function* () {
        const client = yield* T3Client;
        return yield* Stream.runCollect(Stream.take(client.subscribeShell, 3));
      }).pipe(
        provideClient(
          {
            baseUrl: BASE_URL,
            fetch: fetch.fetchFn,
            auth: { type: "bearer", token: "token-1" },
            resubscribeDelayMs: 0,
          },
          connect,
        ),
      );

      expect(items).toEqual([shellSnapshotItem(5), shellEventItem(6), shellEventItem(7)]);
      // Finalizers run per attempt, not accumulated until the stream ends.
      expect(events).toEqual(["open-1", "close-1", "open-2", "close-2"]);
    }),
  );
});
