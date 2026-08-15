import {
  PluginSurfaceError,
  findPluginSurfaceGrant,
  pluginSurfaceGrantCovers,
  pluginSurfaceTemplateOrigin,
  type AuthEnvironmentScope,
  type PluginSurfaceInspection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  PLUGIN_PAGE_BYTE_LIMIT,
  parsePluginPageMetadata,
  suggestPluginSurfaceName,
} from "./pageMetadata.ts";

/**
 * A plugin page holds a token that acts as the user, so its code is minted
 * fresh on every open and dies quickly. Long enough for a slow page load,
 * short enough that a code left in a stale surface URL is worthless.
 */
const PLUGIN_CODE_TTL = Duration.seconds(60);

/** A hostile or hung page must not stall the add-plugin dialog. */
const INSPECT_TIMEOUT = Duration.seconds(5);

export interface IssuedPluginCode {
  readonly code: string;
  readonly expiresAt: string;
}

export class PluginSurfaceService extends Context.Service<
  PluginSurfaceService,
  {
    /**
     * Fetches the URL once for the title, favicon, and description shown in
     * the surface picker. A fetch failure is reported as `unreachable` rather
     * than an error, so a plugin that is not running yet can still be added.
     */
    readonly inspect: (url: string) => Effect.Effect<PluginSurfaceInspection, PluginSurfaceError>;

    /**
     * Mints a one-time code for a plugin page. Refuses unless the origin
     * already holds a consent grant covering the scopes being asked for, so a
     * settings file edited by hand cannot mint itself a token.
     */
    readonly issueCode: (input: {
      readonly url: string;
      readonly label: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<IssuedPluginCode, PluginSurfaceError>;
  }
>()("t3/pluginSurface/PluginSurfaceService") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const pairingGrants = yield* PairingGrantStore.PairingGrantStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const inspect = Effect.fn("PluginSurfaceService.inspect")(function* (url: string) {
    const origin = pluginSurfaceTemplateOrigin(url);
    if (origin === null) {
      return yield* new PluginSurfaceError({ reason: "invalid-url", url });
    }

    // Placeholders have no value yet at add time, so they are stripped to
    // fetch something concrete. The origin is fixed either way.
    const fetchUrl = url.replaceAll(/\{[^{}]*\}/gu, "");
    const suggestedName = suggestPluginSurfaceName(fetchUrl);

    const presentation = yield* httpClient.get(fetchUrl).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.map((body) =>
        parsePluginPageMetadata(body.slice(0, PLUGIN_PAGE_BYTE_LIMIT), fetchUrl),
      ),
      Effect.timeout(INSPECT_TIMEOUT),
      Effect.option,
    );

    return {
      origin,
      suggestedName,
      presentation: presentation._tag === "Some" ? presentation.value : {},
      unreachable: presentation._tag === "None",
    } satisfies PluginSurfaceInspection;
  });

  const issueCode = Effect.fn("PluginSurfaceService.issueCode")(function* (input: {
    readonly url: string;
    readonly label: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }) {
    const origin = pluginSurfaceTemplateOrigin(input.url);
    if (origin === null) {
      return yield* new PluginSurfaceError({ reason: "invalid-url", url: input.url });
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => new PluginSurfaceError({ reason: "issue-failed", url: input.url })),
    );

    const grant = findPluginSurfaceGrant(settings.pluginSurfaceGrants, origin);
    if (grant === null) {
      return yield* new PluginSurfaceError({ reason: "no-grant", url: input.url });
    }
    if (!pluginSurfaceGrantCovers(grant, input.scopes)) {
      return yield* new PluginSurfaceError({ reason: "scope-not-granted", url: input.url });
    }

    // Issued through the same store the pairing flow uses, so the resulting
    // session shows up in `t3 auth session list` and dies with revoke.
    const issued = yield* pairingGrants
      .issueOneTimeToken({
        ttl: PLUGIN_CODE_TTL,
        scopes: input.scopes,
        subject: `plugin:${origin}`,
        label: input.label,
      })
      .pipe(
        Effect.mapError(() => new PluginSurfaceError({ reason: "issue-failed", url: input.url })),
      );

    return {
      code: issued.credential,
      expiresAt: issued.expiresAt.toString(),
    } satisfies IssuedPluginCode;
  });

  return PluginSurfaceService.of({ inspect, issueCode });
});

export const layer = Layer.effect(PluginSurfaceService, make);
