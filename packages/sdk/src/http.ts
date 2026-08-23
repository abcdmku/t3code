import {
  EnvironmentAuthInvalidError,
  EnvironmentHttpCommonError,
  EnvironmentScopeRequiredError,
  IntegrationEnvironmentHttpApi,
} from "@t3tools/contracts/integration/unstable";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import {
  isT3ClientError,
  T3AuthError,
  T3DecodeError,
  T3RequestError,
  T3TransportError,
  type T3ClientError,
} from "./errors.ts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);

/**
 * HTTP client layer for the SDK. Uses the runtime's global `fetch` unless the
 * consumer supplies their own (proxies, custom agents, test stubs).
 */
export const httpClientLayer = (
  fetchFn: typeof globalThis.fetch | undefined,
): Layer.Layer<HttpClient.HttpClient> =>
  fetchFn === undefined
    ? FetchHttpClient.layer
    : FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)));

const normalizeBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** Resolves an endpoint path against the configured base URL, for messages. */
export const endpointUrl = (baseUrl: string, pathname: string): string => {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** Typed client for the environment's HTTP endpoints. */
export const makeApiClient = (baseUrl: string) =>
  HttpApiClient.make(IntegrationEnvironmentHttpApi, {
    baseUrl: normalizeBaseUrl(baseUrl),
  });

const failRequest = (requestUrl: string, cause: unknown): Effect.Effect<never, T3ClientError> => {
  if (isT3ClientError(cause)) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    if (isAuthInvalidError(cause)) {
      return Effect.fail(
        new T3AuthError({
          message: `Authentication with ${requestUrl} failed (${cause.reason}).`,
          reason: cause.reason,
          traceId: cause.traceId,
        }),
      );
    }
    if (isScopeRequiredError(cause)) {
      return Effect.fail(
        new T3AuthError({
          message: `The session is missing the ${cause.requiredScope} scope required by ${requestUrl}.`,
          reason: cause.code,
          requiredScope: cause.requiredScope,
          traceId: cause.traceId,
        }),
      );
    }
    return Effect.fail(
      new T3RequestError({
        message: `${requestUrl} rejected the request (${cause.code}: ${cause.reason}).`,
        code: cause.code,
        traceId: cause.traceId,
      }),
    );
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new T3DecodeError({
        message: `${requestUrl} returned a response that failed schema decoding.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause)) {
    return Effect.fail(
      new T3TransportError({
        message: `Request to ${requestUrl} failed (${cause.message}).`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new T3TransportError({
      message: `Request to ${requestUrl} failed (${String(cause)}).`,
      cause,
    }),
  );
};

/**
 * Bounds one HTTP request with a timeout. It maps declared errors, schema
 * mismatches, and transport faults into `T3ClientError`.
 */
export const executeRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, T3ClientError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new T3TransportError({
              message: `Request to ${requestUrl} timed out after ${timeoutMs}ms.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRequest(requestUrl, cause)),
  );
