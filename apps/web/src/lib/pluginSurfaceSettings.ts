import {
  findPluginSurfaceGrant,
  pluginSurfaceGrantCovers,
  pluginSurfaceTemplateOrigin,
  type AuthEnvironmentScope,
  type PluginSurfaceEntries,
  type PluginSurfaceEntry,
  type PluginSurfaceGrant,
  type PluginSurfaceGrants,
} from "@t3tools/contracts";

/**
 * Builds the settings changes that adding, removing, and consenting to a
 * plugin surface produce. Kept apart from the dialog so the consent rules are
 * testable without rendering anything.
 */

export interface PluginSurfaceConsentRequest {
  readonly origin: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  /** True when the entry declares an MCP URL and the user ticked that grant. */
  readonly mcpApproved: boolean;
}

/**
 * Decides whether the consent screen has to be shown.
 *
 * A grant covers a request only when it holds every scope asked for and
 * already covers MCP if MCP is being asked for. Widening either one needs
 * fresh consent, so a plugin cannot quietly grow its reach by editing its own
 * entry.
 */
export function needsPluginSurfaceConsent(input: {
  readonly grants: PluginSurfaceGrants;
  readonly request: PluginSurfaceConsentRequest;
}): boolean {
  const grant = findPluginSurfaceGrant(input.grants, input.request.origin);
  if (grant === null) return true;
  if (!pluginSurfaceGrantCovers(grant, input.request.scopes)) return true;
  return input.request.mcpApproved && !grant.mcpApproved;
}

/**
 * Records consent for an origin, replacing any grant it already had.
 *
 * Scopes and MCP approval accumulate, because revoking is a separate action
 * through `t3 auth session revoke` and silently narrowing a grant here would
 * make the surface stop working with no explanation.
 */
export function recordPluginSurfaceGrant(input: {
  readonly grants: PluginSurfaceGrants;
  readonly request: PluginSurfaceConsentRequest;
  readonly grantedAt: string;
}): PluginSurfaceGrants {
  const existing = findPluginSurfaceGrant(input.grants, input.request.origin);
  const scopes = [...new Set([...(existing?.scopes ?? []), ...input.request.scopes])];
  const next: PluginSurfaceGrant = {
    origin: input.request.origin,
    scopes,
    mcpApproved: input.request.mcpApproved || (existing?.mcpApproved ?? false),
    grantedAt: input.grantedAt,
  };
  return [...input.grants.filter((grant) => grant.origin !== input.request.origin), next];
}

/** Removes an origin's grant. Entries pointing at it stop being openable. */
export function revokePluginSurfaceGrant(input: {
  readonly grants: PluginSurfaceGrants;
  readonly origin: string;
}): PluginSurfaceGrants {
  return input.grants.filter((grant) => grant.origin !== input.origin);
}

export type PluginSurfaceAddFailure = "invalid-url" | "duplicate-name" | "invalid-mcp-url";

export type PluginSurfaceAddResult =
  | { readonly ok: true; readonly entries: PluginSurfaceEntries; readonly origin: string }
  | { readonly ok: false; readonly reason: PluginSurfaceAddFailure };

/**
 * Adds an entry to a project's list.
 *
 * Names must be unique within a project because the name becomes the MCP tool
 * prefix, and two entries claiming `mcp__my-plugin__*` would be ambiguous to
 * the agent.
 */
export function addPluginSurfaceEntry(input: {
  readonly entries: PluginSurfaceEntries;
  readonly entry: PluginSurfaceEntry;
}): PluginSurfaceAddResult {
  const origin = pluginSurfaceTemplateOrigin(input.entry.url);
  if (origin === null) return { ok: false, reason: "invalid-url" };

  if (input.entries.some((existing) => existing.name === input.entry.name)) {
    return { ok: false, reason: "duplicate-name" };
  }

  const mcpUrl = input.entry.mcpUrl;
  if (mcpUrl !== undefined && pluginSurfaceTemplateOrigin(mcpUrl) !== origin) {
    return { ok: false, reason: "invalid-mcp-url" };
  }

  return { ok: true, entries: [...input.entries, input.entry], origin };
}

export function removePluginSurfaceEntry(input: {
  readonly entries: PluginSurfaceEntries;
  readonly name: string;
}): PluginSurfaceEntries {
  return input.entries.filter((entry) => entry.name !== input.name);
}

/** Plain-language description of a scope for the consent screen. */
export const PLUGIN_SCOPE_DESCRIPTIONS: Record<AuthEnvironmentScope, string> = {
  "orchestration:read": "Read your projects, threads, and turn state",
  "orchestration:operate": "Create threads, start turns, and answer approvals",
  "terminal:operate": "Open and drive terminals in your workspace",
  "review:write": "Read and write code review comments",
  "access:read": "See which clients are paired with this environment",
  "access:write": "Pair and unpair clients on this environment",
  "relay:read": "See this environment's relay connection",
  "relay:write": "Change this environment's relay connection",
};
