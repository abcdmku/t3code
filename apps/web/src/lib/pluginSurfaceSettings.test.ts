import type { PluginSurfaceEntry, PluginSurfaceGrants } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addPluginSurfaceEntry,
  needsPluginSurfaceConsent,
  recordPluginSurfaceGrant,
  removePluginSurfaceEntry,
  revokePluginSurfaceGrant,
  PLUGIN_SCOPE_DESCRIPTIONS,
} from "./pluginSurfaceSettings";

const entry = (overrides: Partial<PluginSurfaceEntry> = {}): PluginSurfaceEntry => ({
  name: "my-plugin",
  url: "https://plugin.test/t/{threadId}",
  scopes: ["orchestration:read"],
  presentation: {},
  ...overrides,
});

const grants = (overrides: Partial<PluginSurfaceGrants[number]> = {}): PluginSurfaceGrants => [
  {
    origin: "https://plugin.test",
    scopes: ["orchestration:read"],
    mcpApproved: false,
    grantedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  },
];

describe("needsPluginSurfaceConsent", () => {
  it("asks when the origin has no grant", () => {
    expect(
      needsPluginSurfaceConsent({
        grants: [],
        request: {
          origin: "https://plugin.test",
          scopes: ["orchestration:read"],
          mcpApproved: false,
        },
      }),
    ).toBe(true);
  });

  it("does not ask again for a grant that already covers the request", () => {
    expect(
      needsPluginSurfaceConsent({
        grants: grants(),
        request: {
          origin: "https://plugin.test",
          scopes: ["orchestration:read"],
          mcpApproved: false,
        },
      }),
    ).toBe(false);
  });

  it("asks again when the entry widens its scopes", () => {
    expect(
      needsPluginSurfaceConsent({
        grants: grants(),
        request: {
          origin: "https://plugin.test",
          scopes: ["orchestration:read", "orchestration:operate"],
          mcpApproved: false,
        },
      }),
    ).toBe(true);
  });

  it("asks again when MCP is newly requested, even with scopes already granted", () => {
    expect(
      needsPluginSurfaceConsent({
        grants: grants(),
        request: {
          origin: "https://plugin.test",
          scopes: ["orchestration:read"],
          mcpApproved: true,
        },
      }),
    ).toBe(true);
  });

  it("does not ask when MCP was already approved", () => {
    expect(
      needsPluginSurfaceConsent({
        grants: grants({ mcpApproved: true }),
        request: {
          origin: "https://plugin.test",
          scopes: ["orchestration:read"],
          mcpApproved: true,
        },
      }),
    ).toBe(false);
  });

  it("asks for a different origin, so a grant cannot be inherited", () => {
    expect(
      needsPluginSurfaceConsent({
        grants: grants(),
        request: {
          origin: "https://evil.test",
          scopes: ["orchestration:read"],
          mcpApproved: false,
        },
      }),
    ).toBe(true);
  });
});

describe("recordPluginSurfaceGrant", () => {
  it("adds a grant for a new origin", () => {
    const next = recordPluginSurfaceGrant({
      grants: [],
      request: {
        origin: "https://plugin.test",
        scopes: ["orchestration:read"],
        mcpApproved: false,
      },
      grantedAt: "2026-08-15T00:00:00.000Z",
    });

    expect(next).toEqual([
      {
        origin: "https://plugin.test",
        scopes: ["orchestration:read"],
        mcpApproved: false,
        grantedAt: "2026-08-15T00:00:00.000Z",
      },
    ]);
  });

  it("merges scopes rather than replacing them", () => {
    const next = recordPluginSurfaceGrant({
      grants: grants(),
      request: {
        origin: "https://plugin.test",
        scopes: ["orchestration:operate"],
        mcpApproved: false,
      },
      grantedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(next[0]?.scopes).toEqual(["orchestration:read", "orchestration:operate"]);
  });

  it("never downgrades an MCP approval that was already given", () => {
    const next = recordPluginSurfaceGrant({
      grants: grants({ mcpApproved: true }),
      request: {
        origin: "https://plugin.test",
        scopes: ["orchestration:read"],
        mcpApproved: false,
      },
      grantedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(next[0]?.mcpApproved).toBe(true);
  });

  it("keeps one grant per origin", () => {
    const next = recordPluginSurfaceGrant({
      grants: grants(),
      request: { origin: "https://plugin.test", scopes: ["orchestration:read"], mcpApproved: true },
      grantedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(next).toHaveLength(1);
    expect(next[0]?.grantedAt).toBe("2026-08-16T00:00:00.000Z");
  });

  it("leaves other origins alone", () => {
    const next = recordPluginSurfaceGrant({
      grants: grants(),
      request: { origin: "https://other.test", scopes: ["orchestration:read"], mcpApproved: false },
      grantedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(next.map((grant) => grant.origin)).toEqual([
      "https://plugin.test",
      "https://other.test",
    ]);
  });
});

describe("revokePluginSurfaceGrant", () => {
  it("drops only the named origin", () => {
    expect(revokePluginSurfaceGrant({ grants: grants(), origin: "https://plugin.test" })).toEqual(
      [],
    );
    expect(
      revokePluginSurfaceGrant({ grants: grants(), origin: "https://other.test" }),
    ).toHaveLength(1);
  });
});

describe("addPluginSurfaceEntry", () => {
  it("appends a valid entry and reports its origin", () => {
    const result = addPluginSurfaceEntry({ entries: [], entry: entry() });

    expect(result).toEqual({
      ok: true,
      entries: [entry()],
      origin: "https://plugin.test",
    });
  });

  it("refuses a duplicate name, which would make the MCP tool prefix ambiguous", () => {
    expect(addPluginSurfaceEntry({ entries: [entry()], entry: entry() })).toEqual({
      ok: false,
      reason: "duplicate-name",
    });
  });

  it.each([
    ["non-http", "javascript:alert(1)"],
    ["templated host", "https://{host}.test/panel"],
    ["relative", "/panel"],
  ])("refuses a %s URL", (_label, url) => {
    expect(addPluginSurfaceEntry({ entries: [], entry: entry({ url }) })).toEqual({
      ok: false,
      reason: "invalid-url",
    });
  });

  it("refuses an MCP URL on a different origin than the page", () => {
    expect(
      addPluginSurfaceEntry({
        entries: [],
        entry: entry({ mcpUrl: "https://evil.test/mcp" }),
      }),
    ).toEqual({ ok: false, reason: "invalid-mcp-url" });
  });

  it("accepts an MCP URL on the same origin", () => {
    const result = addPluginSurfaceEntry({
      entries: [],
      entry: entry({ mcpUrl: "https://plugin.test/mcp" }),
    });

    expect(result.ok).toBe(true);
  });

  it("allows the same name under a different project's list", () => {
    expect(addPluginSurfaceEntry({ entries: [entry({ name: "other" })], entry: entry() }).ok).toBe(
      true,
    );
  });
});

describe("removePluginSurfaceEntry", () => {
  it("drops only the named entry", () => {
    expect(
      removePluginSurfaceEntry({
        entries: [entry(), entry({ name: "keep" })],
        name: "my-plugin",
      }).map((remaining) => remaining.name),
    ).toEqual(["keep"]);
  });
});

describe("PLUGIN_SCOPE_DESCRIPTIONS", () => {
  it("describes every scope in plain words, so the consent screen never shows a raw id", () => {
    for (const [scope, description] of Object.entries(PLUGIN_SCOPE_DESCRIPTIONS)) {
      expect(description).not.toContain(scope);
      expect(description.length).toBeGreaterThan(10);
    }
  });
});
