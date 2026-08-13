import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DispatchResult,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId,
  type UiControlInvokeResult,
} from "@t3tools/contracts/integration";
import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentAuthorizationError,
  type OrchestrationGetSnapshotError,
} from "@t3tools/contracts/integration/unstable";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClientError } from "effect/unstable/rpc";

import { fillCommandBoilerplate, type DispatchableCommandInput } from "./commands.ts";
import {
  isT3ClientError,
  T3AuthError,
  T3ConfigError,
  T3DecodeError,
  T3RequestError,
  T3TokenPersistenceError,
  type T3ClientError,
} from "./errors.ts";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  endpointUrl,
  executeRequest,
  httpClientLayer,
  makeApiClient,
} from "./http.ts";
import { T3WsConnector, type T3WsRpcClient } from "./ws.ts";

const DEFAULT_RESUBSCRIBE_DELAY_MS = 1_000;
const UI_CONTROL_REQUEST_TIMEOUT_MS = 20_000;

// Mirrors packages/client-runtime's connection supervisor RETRY_DELAYS_MS
// ([1s, 2s, 4s, 8s, 16s], then stay at the cap): the base is
// `resubscribeDelayMs` and consecutive failures double it up to 16x.
const RESUBSCRIBE_BACKOFF_MULTIPLIERS = [1, 2, 4, 8, 16] as const;

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

/**
 * The full result of a pairing exchange, handed to {@link T3ClientConfig.onToken}
 * so callers can persist it, and accepted back after a restart as the
 * standalone {@link T3ClientAuth} `token` variant (or as `pairing.token`
 * alongside a fresh credential).
 */
export interface T3AccessToken {
  readonly accessToken: string;
  /** Epoch milliseconds after which the environment rejects the token. */
  readonly expiresAt: number;
  readonly scope: string;
  readonly tokenType: string;
}

export type T3ClientAuth =
  /** A pre-issued access token from `t3 auth session issue --token-only`. */
  | { readonly type: "bearer"; readonly token: string }
  /**
   * A previously persisted pairing exchange result (from
   * {@link T3ClientConfig.onToken}) used on its own after a restart. This does
   * not require a pairing credential. The token is used until it expires. Because
   * no credential is available it cannot be refreshed, so an expired token
   * fails with `T3AuthError` (`reason: "token_expired"`) and the app must be
   * paired again to obtain a fresh credential.
   */
  | { readonly type: "token"; readonly token: T3AccessToken }
  /**
   * A one-time pairing credential exchanged for an access token on first use
   * (`POST /oauth/token`, RFC 8693 token exchange). Lets an app be handed a
   * pairing link instead of an admin token.
   *
   * The credential is single-use: once exchanged (by this client or a
   * previous run) it cannot be exchanged again. Persist the exchange result
   * via {@link T3ClientConfig.onToken} and pass it back after a restart as
   * the standalone `token` auth variant; when the exchanged access token
   * expires the client fails with `T3AuthError` (`reason: "token_expired"`)
   * and the app must be paired again to obtain a fresh credential.
   */
  | {
      readonly type: "pairing";
      readonly credential: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      /**
       * A previously persisted exchange result used as a fast path: while it
       * is unexpired the credential is not exchanged. Once it expires the
       * client falls back to exchanging `credential` (useful when a re-pair
       * handed out a fresh credential but a stale persisted token is still
       * around). Apps restarting with only a persisted token should use the
       * standalone `token` auth variant instead.
       */
      readonly token?: T3AccessToken;
    };

export interface T3ClientConfig {
  /** `http(s)` origin of the environment server, e.g. `http://127.0.0.1:5273`. */
  readonly baseUrl: string;
  /** Omit only for `unsafe-no-auth` environments. */
  readonly auth?: T3ClientAuth;
  /** Overrides the websocket endpoint derived from `baseUrl` (`/ws`). */
  readonly wsUrl?: string;
  /** Custom fetch for proxies or tests; defaults to the runtime's `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Custom WebSocket constructor; defaults to `globalThis.WebSocket`. */
  readonly webSocket?: (url: string, protocols?: string | Array<string>) => globalThis.WebSocket;
  readonly requestTimeoutMs?: number;
  /**
   * Base delay before resubscribing after the websocket transport drops.
   * Consecutive failures back off exponentially from this base, capped at
   * 16x; a successfully resumed subscription resets the backoff. `0`
   * disables the delay entirely (useful for tests).
   */
  readonly resubscribeDelayMs?: number;
  /** Presentation metadata submitted during the pairing exchange. */
  readonly clientMetadata?: AuthClientPresentationMetadata;
  /**
   * Invoked with the full token result after a successful pairing exchange.
   * Persist it and pass it back as the standalone `token` auth variant on
   * the next start. The pairing credential is single-use, so the exchange
   * result is the app's only durable credential.
   *
   * The first authenticated request waits for this callback. A throw or
   * rejected promise fails with `T3TokenPersistenceError`. The next request
   * retries this callback without exchanging the one-time credential again.
   */
  readonly onToken?: (token: T3AccessToken) => void | Promise<void>;
}

export class T3Client extends Context.Service<
  T3Client,
  {
    readonly descriptor: Effect.Effect<ExecutionEnvironmentDescriptor, T3ClientError>;
    readonly shell: Effect.Effect<OrchestrationShellSnapshot, T3ClientError>;
    readonly thread: (
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationThreadDetailSnapshot, T3ClientError>;
    readonly dispatch: (
      command: DispatchableCommandInput,
    ) => Effect.Effect<DispatchResult, T3ClientError>;
    readonly invokeUi: (
      operation: "ui.revealThread",
      input: unknown,
    ) => Effect.Effect<UiControlInvokeResult, T3ClientError>;
    readonly subscribeShell: Stream.Stream<OrchestrationShellStreamItem, T3ClientError>;
    readonly subscribeThread: (
      threadId: ThreadId,
    ) => Stream.Stream<OrchestrationThreadStreamItem, T3ClientError>;
  }
>()("@t3tools/sdk/Client/T3Client") {}

type WsSubscribeError =
  | OrchestrationGetSnapshotError
  | EnvironmentAuthorizationError
  | RpcClientError.RpcClientError;

const mapWsSubscribeError = (
  error: Exclude<WsSubscribeError, RpcClientError.RpcClientError>,
): T3ClientError => {
  if (error._tag === "EnvironmentAuthorizationError") {
    return new T3AuthError({
      message: error.message,
      reason: "insufficient_scope",
      requiredScope: error.requiredScope,
    });
  }
  return new T3RequestError({ message: error.message, code: "subscription_failed" });
};

type SubscribeFailure =
  | { readonly kind: "reconnect" }
  | { readonly kind: "fail"; readonly error: T3ClientError };

/**
 * Splits subscription failures into the two classes the resume loop cares
 * about: transport losses (dropped sockets, ticket-fetch transport faults)
 * reconnect with backoff, while protocol defects, auth/request rejections and
 * decode failures stop the stream because retrying them cannot succeed.
 */
const classifySubscribeFailure = (error: WsSubscribeError | T3ClientError): SubscribeFailure => {
  if (isRpcClientError(error)) {
    return error.reason._tag === "RpcClientDefect"
      ? {
          kind: "fail",
          error: new T3DecodeError({
            message: `The websocket subscription received malformed or incompatible protocol data (${error.reason.message}).`,
            cause: error,
          }),
        }
      : { kind: "reconnect" };
  }
  if (isT3ClientError(error)) {
    return error._tag === "T3TransportError" && error.retryable !== false
      ? { kind: "reconnect" }
      : { kind: "fail", error };
  }
  return { kind: "fail", error: mapWsSubscribeError(error) };
};

const shellItemSequence = (item: OrchestrationShellStreamItem): number | undefined =>
  item.kind === "synchronized"
    ? undefined
    : item.kind === "snapshot"
      ? item.snapshot.snapshotSequence
      : item.sequence;

const shellEventSequence = (item: OrchestrationShellStreamItem): number | undefined =>
  item.kind === "synchronized" || item.kind === "snapshot" ? undefined : item.sequence;

const threadItemSequence = (item: OrchestrationThreadStreamItem): number | undefined =>
  item.kind === "synchronized"
    ? undefined
    : item.kind === "snapshot"
      ? item.snapshot.snapshotSequence
      : item.event.sequence;

const threadEventSequence = (item: OrchestrationThreadStreamItem): number | undefined =>
  item.kind === "event" ? item.event.sequence : undefined;

const validateConfig = (config: T3ClientConfig): Effect.Effect<void, T3ConfigError> =>
  Effect.try({
    try: () => {
      const baseUrl = new URL(config.baseUrl);
      if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
        throw new Error("baseUrl must use http or https");
      }
      if (config.wsUrl !== undefined) {
        const wsUrl = new URL(config.wsUrl);
        if (wsUrl.protocol !== "ws:" && wsUrl.protocol !== "wss:") {
          throw new Error("wsUrl must use ws or wss");
        }
      }
      if (
        config.requestTimeoutMs !== undefined &&
        (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
      ) {
        throw new Error("requestTimeoutMs must be a positive finite number");
      }
      if (
        config.resubscribeDelayMs !== undefined &&
        (!Number.isFinite(config.resubscribeDelayMs) || config.resubscribeDelayMs < 0)
      ) {
        throw new Error("resubscribeDelayMs must be a non-negative finite number");
      }
      const auth = config.auth;
      if (auth?.type === "bearer" && auth.token.trim() === "") {
        throw new Error("auth.token must not be empty");
      }
      if (auth?.type === "pairing" && auth.credential.trim() === "") {
        throw new Error("auth.credential must not be empty");
      }
      const savedToken =
        auth?.type === "token" ? auth.token : auth?.type === "pairing" ? auth.token : undefined;
      if (savedToken !== undefined) {
        if (savedToken.accessToken.trim() === "") {
          throw new Error("auth.token.accessToken must not be empty");
        }
        if (!Number.isFinite(savedToken.expiresAt) || savedToken.expiresAt < 0) {
          throw new Error("auth.token.expiresAt must be a non-negative finite number");
        }
      }
    },
    catch: (cause) =>
      new T3ConfigError({
        message: cause instanceof Error ? cause.message : "The SDK configuration is invalid.",
        field: "config",
        cause,
      }),
  });

const make = (config: T3ClientConfig) =>
  Effect.gen(function* () {
    yield* validateConfig(config);
    const wsConnect = yield* T3WsConnector;
    const httpLayer = httpClientLayer(config.fetch);
    const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const resubscribeBaseMs = config.resubscribeDelayMs ?? DEFAULT_RESUBSCRIBE_DELAY_MS;
    const resubscribeDelay = (consecutiveFailures: number): Duration.Duration =>
      Duration.millis(
        resubscribeBaseMs *
          (RESUBSCRIBE_BACKOFF_MULTIPLIERS[
            Math.min(consecutiveFailures, RESUBSCRIBE_BACKOFF_MULTIPLIERS.length - 1)
          ] ?? 1),
      );
    const api = yield* makeApiClient(config.baseUrl).pipe(Effect.provide(httpLayer));
    const auth = config.auth;
    const clientMetadata = config.clientMetadata;

    const exchangePairingCredential = (
      pairing: Extract<T3ClientAuth, { readonly type: "pairing" }>,
    ) =>
      executeRequest(
        endpointUrl(config.baseUrl, "/oauth/token"),
        timeoutMs,
        api.auth.token({
          headers: {},
          payload: {
            grant_type: AuthTokenExchangeGrantType,
            subject_token: pairing.credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            ...(pairing.scopes === undefined ? {} : { scope: pairing.scopes.join(" ") }),
            ...(clientMetadata?.label === undefined ? {} : { client_label: clientMetadata.label }),
            ...(clientMetadata?.deviceType === undefined
              ? {}
              : { client_device_type: clientMetadata.deviceType }),
            ...(clientMetadata?.os === undefined ? {} : { client_os: clientMetadata.os }),
          },
        }),
      );

    const exchangeToken = (pairing: Extract<T3ClientAuth, { readonly type: "pairing" }>) =>
      Effect.gen(function* () {
        const issuedAt = yield* Clock.currentTimeMillis;
        const result = yield* exchangePairingCredential(pairing);
        const token: T3AccessToken = {
          accessToken: result.access_token,
          expiresAt: issuedAt + result.expires_in * 1_000,
          scope: result.scope,
          tokenType: result.token_type,
        };
        return token;
      });

    let tokenPersisted = config.onToken === undefined;
    let tokenPersistence: Promise<void> | undefined;
    const notifyToken = (token: T3AccessToken): Effect.Effect<void, T3TokenPersistenceError> =>
      Effect.suspend(() => {
        const onToken = config.onToken;
        if (onToken === undefined || tokenPersisted) {
          return Effect.void;
        }
        tokenPersistence ??= Promise.resolve()
          .then(() => onToken(token))
          .then(() => {
            tokenPersisted = true;
          })
          .finally(() => {
            tokenPersistence = undefined;
          });
        return Effect.tryPromise({
          try: () => tokenPersistence!,
          catch: (cause) =>
            new T3TokenPersistenceError({
              message: "The SDK could not persist the access token. The next request will retry.",
              cause,
            }),
        });
      });

    const failTokenExpired = (token: T3AccessToken, detail: string) =>
      Effect.fail(
        new T3AuthError({
          message:
            `The access token expired at ${DateTime.formatIso(DateTime.makeUnsafe(token.expiresAt))}. ` +
            detail,
          reason: "token_expired",
        }),
      );

    const unlessExpired = (
      token: T3AccessToken,
      onExpired: Effect.Effect<T3AccessToken, T3ClientError>,
    ): Effect.Effect<T3AccessToken, T3ClientError> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => (now >= token.expiresAt ? onExpired : Effect.succeed(token))),
      );

    // Pairing credentials are single-use. Cache the exchange, then wait for
    // the application to save its result before any request uses the token.
    const exchangedToken: Effect.Effect<T3AccessToken, T3ClientError> | undefined =
      auth?.type === "pairing"
        ? (yield* Effect.cached(exchangeToken(auth))).pipe(
            Effect.tap(notifyToken),
            Effect.flatMap((token) =>
              unlessExpired(
                token,
                failTokenExpired(
                  token,
                  "Pairing credentials are single-use, so the token cannot be refreshed; pair the app again.",
                ),
              ),
            ),
          )
        : undefined;

    // Expired tokens fail with a distinguishable `token_expired` T3AuthError
    // instead of a server 401. A standalone persisted token has no credential
    // to fall back to; a pairing credential accompanied by an expired
    // persisted token falls back to the exchange.
    const managedToken: Effect.Effect<T3AccessToken, T3ClientError> | undefined =
      auth?.type === "token"
        ? unlessExpired(
            auth.token,
            failTokenExpired(
              auth.token,
              "No pairing credential is available, so the token cannot be refreshed; pair the app again and restart with the new credential.",
            ),
          )
        : auth?.type === "pairing" && exchangedToken !== undefined
          ? auth.token !== undefined
            ? unlessExpired(auth.token, exchangedToken)
            : exchangedToken
          : undefined;

    const accessToken: Effect.Effect<string | undefined, T3ClientError> =
      managedToken === undefined
        ? Effect.succeed(auth?.type === "bearer" ? auth.token : undefined)
        : Effect.map(managedToken, (token) => token.accessToken);

    const authHeaders: Effect.Effect<{ readonly authorization?: string }, T3ClientError> =
      accessToken.pipe(
        Effect.map((token) => (token === undefined ? {} : { authorization: `Bearer ${token}` })),
      );

    const descriptor = executeRequest(
      endpointUrl(config.baseUrl, "/.well-known/t3/environment"),
      timeoutMs,
      api.metadata.descriptor(),
    ).pipe(Effect.withSpan("T3Client.descriptor"));

    const shell = authHeaders.pipe(
      Effect.flatMap((headers) =>
        executeRequest(
          endpointUrl(config.baseUrl, "/api/orchestration/shell"),
          timeoutMs,
          api.orchestration.shellSnapshot({ headers }),
        ),
      ),
      Effect.withSpan("T3Client.shell"),
    );

    const thread = Effect.fn("T3Client.thread")(function* (threadId: ThreadId) {
      const headers = yield* authHeaders;
      return yield* executeRequest(
        endpointUrl(config.baseUrl, `/api/orchestration/threads/${threadId}`),
        timeoutMs,
        api.orchestration.threadSnapshot({ headers, params: { threadId }, payload: {} }),
      );
    });

    // The generated client distributes the command union into one request
    // shape per variant, so a value typed as the whole union needs an
    // assertion back into the request union; the payload is still encoded
    // through the `ClientOrchestrationCommand` schema at runtime.
    type DispatchRequest = Parameters<typeof api.orchestration.dispatch>[0];

    const dispatch = Effect.fn("T3Client.dispatch")(function* (command: DispatchableCommandInput) {
      const filled = yield* fillCommandBoilerplate(command);
      const headers = yield* authHeaders;
      return yield* executeRequest(
        endpointUrl(config.baseUrl, "/api/orchestration/dispatch"),
        timeoutMs,
        api.orchestration.dispatch({ headers, payload: filled } as DispatchRequest),
      );
    });

    const invokeUi = Effect.fn("T3Client.invokeUi")(function* (
      operation: "ui.revealThread",
      input: unknown,
    ) {
      const headers = yield* authHeaders;
      return yield* executeRequest(
        endpointUrl(config.baseUrl, "/api/ui/invoke"),
        Math.max(timeoutMs, UI_CONTROL_REQUEST_TIMEOUT_MS),
        api.ui.invoke({ headers, payload: { operation, input } }),
      );
    });

    const socketUrl = (ticket: string): string => {
      const url = new URL(config.wsUrl ?? config.baseUrl);
      if (config.wsUrl === undefined) {
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      }
      if (url.pathname === "" || url.pathname === "/") {
        url.pathname = "/ws";
      }
      url.searchParams.set("wsTicket", ticket);
      return url.toString();
    };

    // Every (re)connect mints a fresh short-lived ticket so a resumed
    // subscription does not keep using a credential from an older connection.
    const connectSession = Effect.gen(function* () {
      const headers = yield* authHeaders;
      const issued = yield* executeRequest(
        endpointUrl(config.baseUrl, "/api/auth/websocket-ticket"),
        timeoutMs,
        api.auth.webSocketTicket({ headers }),
      );
      return yield* wsConnect({
        socketUrl: socketUrl(issued.ticket),
        ...(config.webSocket === undefined ? {} : { webSocket: config.webSocket }),
      });
    });

    /**
     * The snapshot-then-`afterSequence` subscribe pattern the contracts
     * document as intended client behavior: the first attempt takes the
     * server's initial snapshot; when the transport drops, the subscription
     * resumes after the last seen sequence instead of re-sending the world,
     * and replayed overlap is deduped by sequence.
     *
     * Each connection attempt runs in its own scope, closed when that
     * attempt's stream ends, so socket finalizers never accumulate across
     * reconnects. Transport losses reconnect with capped exponential backoff
     * (see `resubscribeDelayMs`); protocol defects, auth and request
     * rejections fail the stream immediately.
     */
    const subscribeWithResume = <Item>(options: {
      readonly subscribe: (
        client: T3WsRpcClient,
        afterSequence: number | undefined,
      ) => Stream.Stream<Item, WsSubscribeError>;
      readonly itemSequence: (item: Item) => number | undefined;
      readonly eventSequence: (item: Item) => number | undefined;
    }): Stream.Stream<Item, T3ClientError> =>
      Stream.suspend(() => {
        let lastSequence: number | undefined;
        let consecutiveFailures = 0;
        const connectAttempt = Effect.gen(function* () {
          const scope = yield* Scope.make();
          const client = yield* Scope.provide(connectSession, scope).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
            ),
          );
          return options
            .subscribe(client, lastSequence)
            .pipe(Stream.onExit((exit) => Scope.close(scope, exit)));
        });
        const attempt = (): Stream.Stream<Item, T3ClientError> =>
          Stream.unwrap(connectAttempt).pipe(
            Stream.filter((item) => {
              const sequence = options.eventSequence(item);
              return (
                sequence === undefined || lastSequence === undefined || sequence > lastSequence
              );
            }),
            Stream.tap((item) =>
              Effect.sync(() => {
                consecutiveFailures = 0;
                const sequence = options.itemSequence(item);
                if (sequence !== undefined) {
                  lastSequence = Math.max(lastSequence ?? sequence, sequence);
                }
              }),
            ),
            Stream.catch((error) => {
              const failure = classifySubscribeFailure(error);
              if (failure.kind === "fail") {
                return Stream.fail(failure.error);
              }
              const delay = resubscribeDelay(consecutiveFailures);
              consecutiveFailures += 1;
              return Duration.isZero(delay)
                ? Stream.suspend(attempt)
                : Stream.fromEffect(Effect.sleep(delay)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.suspend(attempt)),
                  );
            }),
          );
        return attempt();
      });

    const subscribeShell = subscribeWithResume({
      subscribe: (client, afterSequence) =>
        client[ORCHESTRATION_WS_METHODS.subscribeShell](
          afterSequence === undefined ? {} : { afterSequence },
        ),
      itemSequence: shellItemSequence,
      eventSequence: shellEventSequence,
    }).pipe(Stream.withSpan("T3Client.subscribeShell"));

    const subscribeThread = (threadId: ThreadId) =>
      subscribeWithResume({
        subscribe: (client, afterSequence) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread](
            afterSequence === undefined ? { threadId } : { threadId, afterSequence },
          ),
        itemSequence: threadItemSequence,
        eventSequence: threadEventSequence,
      }).pipe(Stream.withSpan("T3Client.subscribeThread"));

    return {
      service: T3Client.of({
        descriptor,
        shell,
        thread,
        dispatch,
        invokeUi,
        subscribeShell,
        subscribeThread,
      }),
      connectSession,
    };
  });

export const layer = (config: T3ClientConfig): Layer.Layer<T3Client, T3ClientError> =>
  Layer.effect(T3Client, make(config).pipe(Effect.map(({ service }) => service)));

/**
 * Unstable. Opens an authenticated WebSocket session with ticket auth and
 * yields the raw integration RPC client. Its methods may change. The session
 * closes with the `Scope`.
 */
export const unstableWsRpcClient = (
  config: T3ClientConfig,
): Effect.Effect<T3WsRpcClient, T3ClientError, Scope.Scope> =>
  make(config).pipe(Effect.flatMap(({ connectSession }) => connectSession));
