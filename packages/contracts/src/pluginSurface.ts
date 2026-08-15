import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthEnvironmentScope, AuthOrchestrationReadScope } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Plugin surfaces are pages a local app serves. T3 opens one in the browser
 * surface it already ships, hands it a one-time code, and the page then calls
 * the environment's HTTP and WebSocket endpoints directly.
 *
 * Entries live in server settings rather than the repository, because adding
 * one grants a third-party origin a token that acts as the user. A grant that
 * arrived through a checkout would be a grant nobody consented to.
 */

/**
 * An entry name becomes the agent-facing tool prefix `mcp__<name>__<tool>`, so
 * it is held to the character set tool names allow.
 */
export const PLUGIN_SURFACE_NAME_PATTERN = /^[a-z0-9-]+$/;
export const PLUGIN_SURFACE_NAME_MAX_LENGTH = 64;

export const PluginSurfaceName = TrimmedNonEmptyString.check(
  Schema.isPattern(PLUGIN_SURFACE_NAME_PATTERN),
  Schema.isMaxLength(PLUGIN_SURFACE_NAME_MAX_LENGTH),
);
export type PluginSurfaceName = typeof PluginSurfaceName.Type;

/**
 * Title, description, and favicon are self-reported by the page and can change
 * at any time, so they are decoration. The origin is the identity a grant is
 * keyed to.
 */
export const PluginSurfacePresentation = Schema.Struct({
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  faviconUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});
export type PluginSurfacePresentation = typeof PluginSurfacePresentation.Type;

/**
 * The URL template. `{threadId}`, `{projectId}`, `{environmentId}`, and
 * `{serverUrl}` are substituted on open. An unresolved `{threadId}` is left
 * alone so the same template also serves a project-level open.
 */
export const PluginSurfaceEntry = Schema.Struct({
  name: PluginSurfaceName,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  /**
   * Merged into an agent session's `mcpServers` beside T3's own `t3-code`
   * entry. HTTP only, and no headers, which keeps T3 out of the business of
   * storing a plugin's secrets.
   */
  mcpUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  /** Scopes the entry asked for. Shown on the consent screen in plain words. */
  scopes: Schema.Array(AuthEnvironmentScope).pipe(
    Schema.withDecodingDefault(Effect.succeed([AuthOrchestrationReadScope] as const)),
  ),
  presentation: PluginSurfacePresentation.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type PluginSurfaceEntry = typeof PluginSurfaceEntry.Type;

export const PluginSurfaceEntries = Schema.Array(PluginSurfaceEntry);
export type PluginSurfaceEntries = typeof PluginSurfaceEntries.Type;

/**
 * Consent is recorded per origin, not per entry, so renaming a plugin or
 * changing its title cannot inherit another origin's grant. Both grants are
 * collected on one screen but stored separately, because agents using a
 * plugin's tools is a different decision from the page acting as the user.
 */
export const PluginSurfaceGrant = Schema.Struct({
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  scopes: Schema.Array(AuthEnvironmentScope),
  /** True only when the user approved the entry's MCP URL for agent sessions. */
  mcpApproved: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  grantedAt: Schema.String,
});
export type PluginSurfaceGrant = typeof PluginSurfaceGrant.Type;

export const PluginSurfaceGrants = Schema.Array(PluginSurfaceGrant);
export type PluginSurfaceGrants = typeof PluginSurfaceGrants.Type;

/**
 * What T3 learned by fetching the URL once when the entry is added. The name
 * is only a suggestion; the user can type their own.
 */
export const PluginSurfaceInspection = Schema.Struct({
  origin: TrimmedNonEmptyString,
  suggestedName: Schema.NullOr(PluginSurfaceName),
  presentation: PluginSurfacePresentation,
  /** True when the fetch failed. The entry can still be added blind. */
  unreachable: Schema.Boolean,
});
export type PluginSurfaceInspection = typeof PluginSurfaceInspection.Type;

/**
 * The code half of the handoff. The client pairs it with the base URL it is
 * already connected on, because a server behind a tunnel or relay does not
 * know the URL the plugin page will be able to reach it at.
 */
export const PluginSurfaceHandoff = Schema.Struct({
  code: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type PluginSurfaceHandoff = typeof PluginSurfaceHandoff.Type;

/** The fragment key T3 appends when opening a plugin surface. */
export const PLUGIN_SURFACE_HANDOFF_FRAGMENT_KEY = "t3";

/**
 * Builds the `#t3=<base url>|<code>` fragment a plugin page reads on load.
 * Fragments are not sent to the plugin's own web server, so the code stays out
 * of its access logs.
 */
export function buildPluginSurfaceHandoffFragment(input: {
  readonly serverUrl: string;
  readonly code: string;
}): string {
  const value = `${input.serverUrl}|${input.code}`;
  return `${PLUGIN_SURFACE_HANDOFF_FRAGMENT_KEY}=${encodeURIComponent(value)}`;
}

/** The page-side half of {@link buildPluginSurfaceHandoffFragment}. */
export function readPluginSurfaceHandoffFragment(
  hash: string,
): { readonly serverUrl: string; readonly code: string } | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const raw = params.get(PLUGIN_SURFACE_HANDOFF_FRAGMENT_KEY);
  if (raw === null) return null;
  const separator = raw.lastIndexOf("|");
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { serverUrl: raw.slice(0, separator), code: raw.slice(separator + 1) };
}

export const PluginSurfaceFailureReason = Schema.Literals([
  "invalid-url",
  "no-grant",
  "scope-not-granted",
  "issue-failed",
]);
export type PluginSurfaceFailureReason = typeof PluginSurfaceFailureReason.Type;

export class PluginSurfaceError extends Schema.TaggedErrorClass<PluginSurfaceError>()(
  "PluginSurfaceError",
  {
    reason: PluginSurfaceFailureReason,
    url: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-url":
        return "Plugin surface URLs must be absolute http or https URLs with a fixed host.";
      case "no-grant":
        return "This origin has not been granted access to act on your behalf.";
      case "scope-not-granted":
        return "This plugin asked for scopes beyond what you granted its origin.";
      case "issue-failed":
        return "Failed to issue a one-time code for this plugin surface.";
    }
  }
}

const ALLOWED_PLUGIN_SURFACE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Plugin URLs resolve to http(s) only. Returns null when the value is not a
 * usable absolute URL, so callers can reject without throwing.
 */
export function pluginSurfaceOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!ALLOWED_PLUGIN_SURFACE_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.origin;
}

/**
 * A template still carrying `{...}` placeholders is not itself a valid URL, so
 * the origin check runs against the template with placeholders stripped to a
 * benign value.
 *
 * A placeholder inside the scheme, host, or port is rejected outright. The
 * origin is what a grant is keyed to, so a template that can resolve to more
 * than one origin would let the opened page differ from the consented one.
 * Percent-encoded braces are decoded first, so `%7BthreadId%7D` cannot smuggle
 * a placeholder past the check.
 */
export function pluginSurfaceTemplateOrigin(template: string): string | null {
  const decoded = template.replaceAll(/%7B/giu, "{").replaceAll(/%7D/giu, "}");
  const schemeEnd = decoded.indexOf("://");
  if (schemeEnd === -1) return null;
  const authorityEnd = decoded.indexOf("/", schemeEnd + 3);
  const authority = authorityEnd === -1 ? decoded : decoded.slice(0, authorityEnd);
  if (authority.includes("{") || authority.includes("}")) return null;
  return pluginSurfaceOrigin(decoded.replaceAll(/\{[^{}]*\}/gu, "x"));
}

/** Finds the grant covering an origin, or null when the origin has none. */
export function findPluginSurfaceGrant(
  grants: PluginSurfaceGrants,
  origin: string,
): PluginSurfaceGrant | null {
  return grants.find((grant) => grant.origin === origin) ?? null;
}

/**
 * A grant covers a request only when it was issued for the same origin and
 * already carries every scope being asked for. Widening scopes needs fresh
 * consent.
 */
export function pluginSurfaceGrantCovers(
  grant: PluginSurfaceGrant,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean {
  return scopes.every((scope) => grant.scopes.includes(scope));
}
