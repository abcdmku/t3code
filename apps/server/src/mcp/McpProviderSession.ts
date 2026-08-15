import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { PluginMcpServer } from "../pluginSurface/mcpServers.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

/**
 * Plugin-contributed MCP servers, resolved per thread at session start from the
 * thread's project. Kept beside the T3 session rather than inside it because a
 * plugin's servers are user configuration, not part of the credential T3 issues
 * itself.
 */
const pluginServersByThread = new Map<ThreadId, Record<string, PluginMcpServer>>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function setPluginMcpServers(
  threadId: ThreadId,
  servers: Record<string, PluginMcpServer>,
): void {
  if (Object.keys(servers).length === 0) {
    pluginServersByThread.delete(threadId);
    return;
  }
  pluginServersByThread.set(threadId, servers);
}

export function readPluginMcpServers(threadId: ThreadId): Record<string, PluginMcpServer> {
  return pluginServersByThread.get(threadId) ?? {};
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
  pluginServersByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
  pluginServersByThread.clear();
}
