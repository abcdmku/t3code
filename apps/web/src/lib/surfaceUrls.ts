/** Resolve the placeholders supported by custom project surfaces. */

export interface SurfaceUrlContext {
  readonly environmentId: string;
  readonly projectId: string;
  /** The HTTP base URL for this environment, if the client has connected. */
  readonly serverUrl?: string | undefined;
  /** Absent for project-level opens without a thread context. */
  readonly threadId?: string | undefined;
}

const ALLOWED_SURFACE_PROTOCOLS = new Set(["http:", "https:"]);

/** Remove credentials, query, and hash before substituting `{serverUrl}`. */
export function sanitizeServerUrlForTemplate(serverUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return null;
  }
  if (!ALLOWED_SURFACE_PROTOCOLS.has(parsed.protocol)) return null;
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${basePath}`;
}

export function resolveSurfaceUrlTemplate(template: string, context: SurfaceUrlContext): string {
  let resolved = template
    .replaceAll("{environmentId}", encodeURIComponent(context.environmentId))
    .replaceAll("{projectId}", encodeURIComponent(context.projectId));
  const serverUrl =
    context.serverUrl === undefined ? null : sanitizeServerUrlForTemplate(context.serverUrl);
  if (serverUrl !== null) {
    resolved = resolved.replaceAll("{serverUrl}", serverUrl);
  }
  if (context.threadId !== undefined) {
    resolved = resolved.replaceAll("{threadId}", encodeURIComponent(context.threadId));
  }
  return resolved;
}

const KNOWN_SURFACE_PLACEHOLDERS = [
  "{serverUrl}",
  "{threadId}",
  "{projectId}",
  "{environmentId}",
] as const;

/** Allow only complete HTTP and HTTPS URLs. */
export function isAllowedSurfaceUrl(url: string): boolean {
  const braceDecoded = url.replaceAll(/%7B/gi, "{").replaceAll(/%7D/gi, "}");
  if (
    KNOWN_SURFACE_PLACEHOLDERS.some((placeholder) => braceDecoded.includes(placeholder)) ||
    /\{[^{}]+\}/u.test(braceDecoded)
  ) {
    return false;
  }
  try {
    return ALLOWED_SURFACE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Keep duplicate surface names as separate React entries. */
export function surfaceEntryKey(
  surface: { readonly name: string; readonly url: string; readonly threadUrl?: string | undefined },
  index: number,
): string {
  return `${index}:${surface.name}:${surface.threadUrl ?? surface.url}`;
}
