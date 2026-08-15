import {
  findPluginSurfaceGrant,
  pluginSurfaceOrigin,
  type PluginSurfaceEntries,
  type PluginSurfaceGrants,
} from "@t3tools/contracts";

/**
 * The shape Claude's `mcpServers` option takes for an HTTP server. T3's own
 * `t3-code` entry uses the same shape with an auth header; a plugin's entry
 * never carries headers, which keeps T3 out of the business of storing a
 * plugin's secrets.
 */
export interface PluginMcpServer {
  readonly type: "http";
  readonly url: string;
}

/**
 * Resolves the MCP servers an agent session should see for a project.
 *
 * An entry contributes a server only when it declares an MCP URL, that URL is
 * http(s), and the user approved the MCP grant for its origin. Approving the
 * page grant alone is not enough: letting agents call a plugin's tools is a
 * separate decision from letting the page act as the user.
 *
 * Tools then reach the agent as `mcp__<entry-name>__<tool>`, which is why
 * entry names are held to the tool-name character set.
 */
export function resolvePluginMcpServers(input: {
  readonly entries: PluginSurfaceEntries;
  readonly grants: PluginSurfaceGrants;
}): Record<string, PluginMcpServer> {
  const servers: Record<string, PluginMcpServer> = {};
  for (const entry of input.entries) {
    const mcpUrl = entry.mcpUrl;
    if (mcpUrl === undefined) continue;

    // The grant is keyed to the page's origin, so an entry cannot point its
    // MCP URL at a second origin and inherit the first one's approval.
    const pageOrigin = pluginSurfaceOrigin(entry.url.replaceAll(/\{[^{}]*\}/gu, "x"));
    const mcpOrigin = pluginSurfaceOrigin(mcpUrl);
    if (pageOrigin === null || mcpOrigin === null || pageOrigin !== mcpOrigin) continue;

    const grant = findPluginSurfaceGrant(input.grants, pageOrigin);
    if (grant === null || !grant.mcpApproved) continue;

    // Last entry wins on a duplicate name, matching how the settings list is
    // read top to bottom. Names are unique in practice; this only decides
    // what a hand-edited settings file does.
    servers[entry.name] = { type: "http", url: mcpUrl };
  }
  return servers;
}
