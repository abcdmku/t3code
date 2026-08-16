import { buildPluginSurfaceHandoffFragment, pluginSurfaceOrigin } from "@t3tools/contracts";

/**
 * Resolves a plugin surface's URL template for one open.
 *
 * `{threadId}` is left in place when there is no thread, so the same entry
 * also serves a project-level open. Every other placeholder is always
 * available.
 */
export interface PluginSurfaceUrlContext {
  readonly environmentId: string;
  readonly projectId: string;
  /** The HTTP base URL this client is connected on. */
  readonly serverUrl: string;
  /** Absent for a project-level open with no thread in view. */
  readonly threadId?: string | undefined;
}

/**
 * Strips credentials, query, and fragment so `{serverUrl}` never carries a
 * token into a third-party page. Returns null when the value is unusable.
 */
export function sanitizeServerUrl(serverUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return null;
  }
  if (pluginSurfaceOrigin(serverUrl) === null) return null;
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.protocol}//${parsed.host}${basePath}`;
}

export function resolvePluginSurfaceTemplate(
  template: string,
  context: PluginSurfaceUrlContext,
): string {
  let resolved = template
    .replaceAll("{environmentId}", encodeURIComponent(context.environmentId))
    .replaceAll("{projectId}", encodeURIComponent(context.projectId));

  const serverUrl = sanitizeServerUrl(context.serverUrl);
  if (serverUrl !== null) resolved = resolved.replaceAll("{serverUrl}", serverUrl);

  if (context.threadId !== undefined) {
    resolved = resolved.replaceAll("{threadId}", encodeURIComponent(context.threadId));
  }
  return resolved;
}

/**
 * Attaches the handoff to a resolved URL.
 *
 * The code rides the fragment because browsers do not send fragments to the
 * server, so it stays out of the plugin's access logs. Any fragment the
 * template already carried is replaced rather than appended to, so a template
 * cannot smuggle its own `t3=` value past the handoff.
 */
export function attachPluginSurfaceHandoff(input: {
  readonly url: string;
  readonly serverUrl: string;
  readonly code: string;
}): string {
  const sanitized = sanitizeServerUrl(input.serverUrl);
  if (sanitized === null) return input.url;
  const withoutFragment = input.url.split("#")[0] ?? input.url;
  const fragment = buildPluginSurfaceHandoffFragment({
    serverUrl: sanitized,
    code: input.code,
  });
  return `${withoutFragment}#${fragment}`;
}
