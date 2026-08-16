import type { PluginSurfaceEntries, PluginSurfaceGrants } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeAgentMcpServers, resolvePluginMcpServers } from "./mcpServers.ts";

const entry = (overrides: Partial<PluginSurfaceEntries[number]>): PluginSurfaceEntries[number] => ({
  name: "my-plugin",
  url: "https://plugin.test/t/{threadId}",
  scopes: ["orchestration:read"],
  presentation: {},
  ...overrides,
});

const grant = (overrides: Partial<PluginSurfaceGrants[number]>): PluginSurfaceGrants[number] => ({
  origin: "https://plugin.test",
  scopes: ["orchestration:read"],
  mcpApproved: true,
  grantedAt: "2026-08-15T00:00:00.000Z",
  ...overrides,
});

describe("resolvePluginMcpServers", () => {
  it("exposes an approved entry as an http server", () => {
    expect(
      resolvePluginMcpServers({
        entries: [entry({ mcpUrl: "https://plugin.test/mcp" })],
        grants: [grant({})],
      }),
    ).toEqual({ "my-plugin": { type: "http", url: "https://plugin.test/mcp" } });
  });

  it("skips an entry that declares no MCP URL", () => {
    expect(resolvePluginMcpServers({ entries: [entry({})], grants: [grant({})] })).toEqual({});
  });

  it("skips an entry whose origin has no grant at all", () => {
    expect(
      resolvePluginMcpServers({
        entries: [entry({ mcpUrl: "https://plugin.test/mcp" })],
        grants: [],
      }),
    ).toEqual({});
  });

  it("skips an entry granted the page but not MCP, because those are separate decisions", () => {
    expect(
      resolvePluginMcpServers({
        entries: [entry({ mcpUrl: "https://plugin.test/mcp" })],
        grants: [grant({ mcpApproved: false })],
      }),
    ).toEqual({});
  });

  it("refuses an MCP URL on a different origin than the page", () => {
    expect(
      resolvePluginMcpServers({
        entries: [entry({ mcpUrl: "https://evil.test/mcp" })],
        grants: [grant({})],
      }),
    ).toEqual({});
  });

  it("treats a different port as a different origin", () => {
    expect(
      resolvePluginMcpServers({
        entries: [entry({ mcpUrl: "https://plugin.test:8443/mcp" })],
        grants: [grant({})],
      }),
    ).toEqual({});
  });

  it.each([
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["relative", "/mcp"],
  ])("refuses a %s MCP URL", (_label, mcpUrl) => {
    expect(resolvePluginMcpServers({ entries: [entry({ mcpUrl })], grants: [grant({})] })).toEqual(
      {},
    );
  });

  it("resolves several entries independently", () => {
    const servers = resolvePluginMcpServers({
      entries: [
        entry({ name: "approved", mcpUrl: "https://plugin.test/mcp" }),
        entry({ name: "ungranted", url: "https://other.test/p", mcpUrl: "https://other.test/mcp" }),
      ],
      grants: [grant({})],
    });

    expect(Object.keys(servers)).toEqual(["approved"]);
  });

  it("never carries headers, so T3 stores no plugin secrets", () => {
    const servers = resolvePluginMcpServers({
      entries: [entry({ mcpUrl: "https://plugin.test/mcp" })],
      grants: [grant({})],
    });

    expect(Object.keys(servers["my-plugin"] ?? {})).toEqual(["type", "url"]);
  });
});

describe("mergeAgentMcpServers", () => {
  const t3Server = {
    type: "http" as const,
    url: "http://127.0.0.1:9/mcp",
    headers: { Authorization: "Bearer t3" },
  };

  it("puts plugin servers beside T3's own entry", () => {
    expect(
      mergeAgentMcpServers({
        pluginServers: { "my-plugin": { type: "http", url: "https://plugin.test/mcp" } },
        t3Server,
      }),
    ).toEqual({
      "my-plugin": { type: "http", url: "https://plugin.test/mcp" },
      "t3-code": t3Server,
    });
  });

  it("never lets a plugin named t3-code displace T3's own server", () => {
    const merged = mergeAgentMcpServers({
      pluginServers: { "t3-code": { type: "http", url: "https://evil.test/mcp" } },
      t3Server,
    });

    expect(merged["t3-code"]).toEqual(t3Server);
    expect(Object.keys(merged)).toEqual(["t3-code"]);
  });

  it("returns only plugin servers when T3 has no session", () => {
    expect(
      mergeAgentMcpServers({
        pluginServers: { "my-plugin": { type: "http", url: "https://plugin.test/mcp" } },
        t3Server: undefined,
      }),
    ).toEqual({ "my-plugin": { type: "http", url: "https://plugin.test/mcp" } });
  });

  it("returns only T3's entry when no plugins are approved", () => {
    expect(mergeAgentMcpServers({ pluginServers: {}, t3Server })).toEqual({ "t3-code": t3Server });
  });
});
