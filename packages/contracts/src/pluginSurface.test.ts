import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import {
  PluginSurfaceEntry,
  PluginSurfaceGrant,
  findPluginSurfaceGrant,
  pluginSurfaceGrantCovers,
  pluginSurfaceOrigin,
  pluginSurfaceTemplateOrigin,
  buildPluginSurfaceHandoffFragment,
  readPluginSurfaceHandoffFragment,
} from "./pluginSurface.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings.ts";

const decodeEntry = Schema.decodeUnknownSync(PluginSurfaceEntry);
const decodeGrant = Schema.decodeUnknownSync(PluginSurfaceGrant);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("PluginSurfaceEntry", () => {
  it("defaults to orchestration:read when the entry asks for nothing", () => {
    const entry = decodeEntry({ name: "my-plugin", url: "https://example.test/panel" });

    expect(entry.scopes).toEqual(["orchestration:read"]);
    expect(entry.presentation).toEqual({});
  });

  it("keeps the scopes an entry asked for", () => {
    const entry = decodeEntry({
      name: "my-plugin",
      url: "https://example.test/panel",
      scopes: ["orchestration:read", "orchestration:operate"],
    });

    expect(entry.scopes).toEqual(["orchestration:read", "orchestration:operate"]);
  });

  it.each([
    ["uppercase", "My-Plugin"],
    ["underscore", "my_plugin"],
    ["space", "my plugin"],
    ["empty", ""],
  ])("rejects a %s name, because the name becomes an MCP tool prefix", (_label, name) => {
    expect(() => decodeEntry({ name, url: "https://example.test/panel" })).toThrow();
  });

  it("accepts digits and hyphens", () => {
    expect(decodeEntry({ name: "plugin-2", url: "https://example.test" }).name).toBe("plugin-2");
  });

  it("carries an optional MCP URL", () => {
    const entry = decodeEntry({
      name: "my-plugin",
      url: "https://example.test/panel",
      mcpUrl: "https://example.test/mcp",
    });

    expect(entry.mcpUrl).toBe("https://example.test/mcp");
  });
});

describe("pluginSurfaceOrigin", () => {
  it("returns the origin for http and https", () => {
    expect(pluginSurfaceOrigin("https://example.test/panel?a=1")).toBe("https://example.test");
    expect(pluginSurfaceOrigin("http://localhost:5173/panel")).toBe("http://localhost:5173");
  });

  it.each([
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["data", "data:text/html,<h1>hi</h1>"],
    ["relative", "/panel"],
    ["garbage", "not a url"],
  ])("rejects a %s URL", (_label, url) => {
    expect(pluginSurfaceOrigin(url)).toBeNull();
  });

  it("treats a different port as a different origin", () => {
    expect(pluginSurfaceOrigin("https://example.test:8443/panel")).toBe(
      "https://example.test:8443",
    );
  });
});

describe("pluginSurfaceTemplateOrigin", () => {
  it("resolves the origin of a template that still has placeholders", () => {
    expect(pluginSurfaceTemplateOrigin("https://example.test/t/{threadId}?p={projectId}")).toBe(
      "https://example.test",
    );
  });

  it.each([
    ["host", "https://{host}.test/panel"],
    ["port", "https://example.test:{port}/panel"],
    ["whole authority", "https://{origin}/panel"],
    ["percent-encoded host", "https://%7Bhost%7D.test/panel"],
    ["no path after a templated host", "https://{host}.test"],
  ])(
    "rejects a placeholder in the %s, so a template cannot resolve to a second origin",
    (_label, template) => {
      expect(pluginSurfaceTemplateOrigin(template)).toBeNull();
    },
  );

  it("allows a percent-encoded placeholder in the path", () => {
    expect(pluginSurfaceTemplateOrigin("https://example.test/t/%7BthreadId%7D")).toBe(
      "https://example.test",
    );
  });

  it("rejects a non-http template", () => {
    expect(pluginSurfaceTemplateOrigin("javascript:{threadId}")).toBeNull();
  });
});

describe("plugin surface grants", () => {
  const grant = decodeGrant({
    origin: "https://example.test",
    scopes: ["orchestration:read"],
    grantedAt: "2026-08-15T00:00:00.000Z",
  });

  it("defaults mcpApproved to false, so adding an MCP URL needs fresh consent", () => {
    expect(grant.mcpApproved).toBe(false);
  });

  it("finds a grant by exact origin", () => {
    expect(findPluginSurfaceGrant([grant], "https://example.test")).toBe(grant);
  });

  it("does not match a different origin", () => {
    expect(findPluginSurfaceGrant([grant], "https://evil.test")).toBeNull();
    expect(findPluginSurfaceGrant([grant], "http://example.test")).toBeNull();
  });

  it("covers scopes it already holds", () => {
    expect(pluginSurfaceGrantCovers(grant, ["orchestration:read"])).toBe(true);
    expect(pluginSurfaceGrantCovers(grant, [])).toBe(true);
  });

  it("does not cover a widened scope request", () => {
    expect(pluginSurfaceGrantCovers(grant, ["orchestration:read", "orchestration:operate"])).toBe(
      false,
    );
  });
});

describe("ServerSettings plugin surface storage", () => {
  it("defaults to no entries and no grants", () => {
    expect(DEFAULT_SERVER_SETTINGS.pluginSurfaces).toEqual({});
    expect(DEFAULT_SERVER_SETTINGS.pluginSurfaceGrants).toEqual([]);
  });

  it("stores entries per project", () => {
    const settings = decodeServerSettings({
      pluginSurfaces: {
        "project-a": [{ name: "my-plugin", url: "https://example.test/t/{threadId}" }],
      },
    });

    expect(settings.pluginSurfaces[ProjectId.make("project-a")]?.[0]?.name).toBe("my-plugin");
    expect(settings.pluginSurfaces[ProjectId.make("project-b")]).toBeUndefined();
  });

  it("rejects an entry with an invalid name rather than dropping it silently", () => {
    expect(() =>
      decodeServerSettings({
        pluginSurfaces: { "project-a": [{ name: "Bad Name", url: "https://example.test" }] },
      }),
    ).toThrow();
  });
});

describe("plugin surface handoff fragment", () => {
  it("round-trips a base URL and code", () => {
    const fragment = buildPluginSurfaceHandoffFragment({
      serverUrl: "https://env.test:3000",
      code: "ABC123",
    });

    expect(readPluginSurfaceHandoffFragment(`#${fragment}`)).toEqual({
      serverUrl: "https://env.test:3000",
      code: "ABC123",
    });
  });

  it("reads a fragment with or without the leading hash", () => {
    const fragment = buildPluginSurfaceHandoffFragment({
      serverUrl: "http://localhost:1234",
      code: "XYZ",
    });

    expect(readPluginSurfaceHandoffFragment(fragment)?.code).toBe("XYZ");
  });

  it("splits on the last separator, so a base URL containing one still parses", () => {
    expect(
      readPluginSurfaceHandoffFragment(
        `#${buildPluginSurfaceHandoffFragment({ serverUrl: "https://env.test/a|b", code: "CODE" })}`,
      ),
    ).toEqual({ serverUrl: "https://env.test/a|b", code: "CODE" });
  });

  it("ignores other fragment keys", () => {
    expect(readPluginSurfaceHandoffFragment("#other=1")).toBeNull();
    expect(readPluginSurfaceHandoffFragment("")).toBeNull();
  });

  it.each([
    ["missing code", "#t3=https%3A%2F%2Fenv.test%7C"],
    ["missing base URL", "#t3=%7CCODE"],
    ["no separator", "#t3=nope"],
  ])("rejects a malformed fragment (%s)", (_label, hash) => {
    expect(readPluginSurfaceHandoffFragment(hash)).toBeNull();
  });
});
