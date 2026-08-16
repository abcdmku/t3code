import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  PluginSurfaceError,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginSurfaceService from "./PluginSurfaceService.ts";

const PLUGIN_URL = "http://127.0.0.1:9/panel?thread={threadId}";
const PLUGIN_ORIGIN = "http://127.0.0.1:9";

const settingsWith = (overrides: Partial<ServerSettingsType>): ServerSettingsType => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...overrides,
});

const grantedSettings = (
  overrides: Partial<ServerSettingsType["pluginSurfaceGrants"][number]> = {},
) =>
  settingsWith({
    pluginSurfaceGrants: [
      {
        origin: PLUGIN_ORIGIN,
        scopes: ["orchestration:read"],
        mcpApproved: false,
        grantedAt: "2026-08-15T00:00:00.000Z",
        ...overrides,
      },
    ],
  });

/**
 * Built on the real PairingGrantStore rather than a mock, because the point of
 * this suite is that a plugin code is a genuine bootstrap credential the
 * pairing flow already knows how to redeem.
 */
const makeLayer = (settings: ServerSettingsType) =>
  PluginSurfaceService.layer.pipe(
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(settings),
        updateSettings: () => Effect.succeed(settings),
        streamChanges: Stream.empty,
      }),
    ),
    // provideMerge, not provide: the redemption test reaches for the same
    // store to prove the code the service minted is the one pairing redeems.
    Layer.provideMerge(
      PairingGrantStore.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-surface-" })),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );

it.layer(NodeServices.layer)("PluginSurfaceService.issueCode", (it) => {
  it.effect("mints a code when the origin holds a covering grant", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const issued = yield* service.issueCode({
        url: PLUGIN_URL,
        label: "demo-panel",
        scopes: ["orchestration:read"],
      });

      expect(issued.code.length).toBeGreaterThan(0);
      expect(issued.expiresAt).not.toBe("");
    }).pipe(Effect.provide(makeLayer(grantedSettings()))),
  );

  it.effect("mints a distinct code per open, so a stale URL is worthless", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const input = {
        url: PLUGIN_URL,
        label: "demo-panel",
        scopes: ["orchestration:read"] as const,
      };
      const first = yield* service.issueCode(input);
      const second = yield* service.issueCode(input);

      expect(first.code).not.toBe(second.code);
    }).pipe(Effect.provide(makeLayer(grantedSettings()))),
  );

  it.effect("the minted code is redeemable exactly once", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* service.issueCode({
        url: PLUGIN_URL,
        label: "demo-panel",
        scopes: ["orchestration:read"],
      });

      const grant = yield* grants.consume(issued.code);
      expect(grant.scopes).toEqual(["orchestration:read"]);
      expect(grant.subject).toBe(`plugin:${PLUGIN_ORIGIN}`);

      const replay = yield* Effect.flip(grants.consume(issued.code));
      expect(replay._tag).not.toBe(undefined);
    }).pipe(Effect.provide(makeLayer(grantedSettings()))),
  );

  it.effect("refuses when the origin has no grant, so hand-edited settings cannot mint", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const failure = yield* Effect.flip(
        service.issueCode({
          url: PLUGIN_URL,
          label: "demo-panel",
          scopes: ["orchestration:read"],
        }),
      );

      expect(failure).toBeInstanceOf(PluginSurfaceError);
      expect((failure as PluginSurfaceError).reason).toBe("no-grant");
    }).pipe(Effect.provide(makeLayer(settingsWith({})))),
  );

  it.effect("refuses a scope the grant does not cover", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const failure = yield* Effect.flip(
        service.issueCode({
          url: PLUGIN_URL,
          label: "demo-panel",
          scopes: ["orchestration:read", "orchestration:operate"],
        }),
      );

      expect((failure as PluginSurfaceError).reason).toBe("scope-not-granted");
    }).pipe(Effect.provide(makeLayer(grantedSettings()))),
  );

  it.effect("refuses a URL whose host is a placeholder", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const failure = yield* Effect.flip(
        service.issueCode({
          url: "https://{host}.test/panel",
          label: "demo-panel",
          scopes: ["orchestration:read"],
        }),
      );

      expect((failure as PluginSurfaceError).reason).toBe("invalid-url");
    }).pipe(Effect.provide(makeLayer(grantedSettings()))),
  );

  it.effect("does not let a grant on one origin mint for another", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const failure = yield* Effect.flip(
        service.issueCode({
          url: "http://127.0.0.1:10/panel",
          label: "demo-panel",
          scopes: ["orchestration:read"],
        }),
      );

      expect((failure as PluginSurfaceError).reason).toBe("no-grant");
    }).pipe(Effect.provide(makeLayer(grantedSettings()))),
  );
});

it.layer(NodeServices.layer)("PluginSurfaceService.inspect", (it) => {
  it.effect("reports an unreachable page instead of failing, so it can still be added", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      // Port 9 (discard) refuses, which is the "app not started yet" case.
      const inspection = yield* service.inspect("http://127.0.0.1:9/panel");

      expect(inspection.unreachable).toBe(true);
      expect(inspection.origin).toBe(PLUGIN_ORIGIN);
      expect(inspection.presentation).toEqual({});
    }).pipe(Effect.provide(makeLayer(settingsWith({})))),
  );

  it.effect("refuses a non-http URL", () =>
    Effect.gen(function* () {
      const service = yield* PluginSurfaceService.PluginSurfaceService;
      const failure = yield* Effect.flip(service.inspect("javascript:alert(1)"));

      expect((failure as PluginSurfaceError).reason).toBe("invalid-url");
    }).pipe(Effect.provide(makeLayer(settingsWith({})))),
  );
});
