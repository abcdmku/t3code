/**
 * Parses the title, description, and favicon a plugin page reports about
 * itself. T3 fetches the page once when an entry is added so the surface
 * picker has something to show.
 *
 * Everything here is self-reported and can change at any time, so it is
 * decoration only. The origin is what a consent grant is keyed to.
 */

export interface PluginPageMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly faviconUrl?: string;
}

/** Cap on what is read from the page, so a hostile response cannot fill memory. */
export const PLUGIN_PAGE_BYTE_LIMIT = 512 * 1024;

const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 500;

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

function clean(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = decodeEntities(value).replaceAll(/\s+/gu, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}

/** Reads an attribute out of a single tag's attribute text. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "iu").exec(tag);
  if (match === null) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

function parseTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return clean(match?.[1], TITLE_MAX_LENGTH);
}

/**
 * Prefers `og:description` over `name="description"`, matching what link
 * unfurlers do, so a page that ships both gets the copy it wrote for sharing.
 */
function parseDescription(html: string): string | undefined {
  let named: string | undefined;
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const content = attribute(tag, "content");
    if (content === undefined) continue;
    const property = attribute(tag, "property")?.toLowerCase();
    if (property === "og:description") return clean(content, DESCRIPTION_MAX_LENGTH);
    if (attribute(tag, "name")?.toLowerCase() === "description") named ??= content;
  }
  return clean(named, DESCRIPTION_MAX_LENGTH);
}

/**
 * Takes the last icon link, which is conventionally the highest-resolution
 * one, and resolves it against the page URL. Falls back to `/favicon.ico`.
 */
function parseFaviconUrl(html: string, pageUrl: string): string | undefined {
  let href: string | undefined;
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = attribute(tag, "rel")?.toLowerCase();
    if (rel === undefined) continue;
    const relTokens = rel.split(/\s+/u);
    if (!relTokens.includes("icon")) continue;
    const candidate = attribute(tag, "href");
    if (candidate !== undefined && candidate.trim() !== "") href = candidate.trim();
  }
  try {
    return new URL(href ?? "/favicon.ico", pageUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Only the document head is worth scanning, so parsing stops at `</head>`
 * when the page has one.
 */
export function parsePluginPageMetadata(html: string, pageUrl: string): PluginPageMetadata {
  const headEnd = html.search(/<\/head\s*>/iu);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const title = parseTitle(head);
  const description = parseDescription(head);
  const faviconUrl = parseFaviconUrl(head, pageUrl);
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(faviconUrl === undefined ? {} : { faviconUrl }),
  };
}

/**
 * Derives the default entry name from a URL's hostname, since the name has to
 * fit `[a-z0-9-]` to work as an MCP tool prefix. Returns null when nothing
 * usable survives, and the user has to type one.
 */
export function suggestPluginSurfaceName(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const suggestion = hostname
    .replace(/^www\./iu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return suggestion === "" ? null : suggestion.slice(0, 64).replace(/-+$/u, "");
}
