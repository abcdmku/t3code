import type {
  EnvironmentId,
  PluginSurfaceEntry,
  PluginSurfaceInspection,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { usePreparedConnection } from "~/state/session";

import { openPluginSurface } from "./openPluginSurface";

/**
 * Everything a surface picker needs to list, open, and register plugin
 * surfaces for one project.
 *
 * Entries are read from server settings rather than held in component state,
 * so adding one in a second window shows up here without a refresh.
 */
export function usePluginSurfaces(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const settings = useEnvironmentSettings(input.environmentId);
  const connection = usePreparedConnection(input.environmentId);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const issueCode = useAtomCommand(serverEnvironment.issuePluginSurfaceCode, {
    reportFailure: false,
  });
  const inspectCommand = useAtomCommand(serverEnvironment.inspectPluginSurface, {
    reportFailure: false,
  });

  const entries = useMemo<ReadonlyArray<PluginSurfaceEntry>>(
    () => (input.projectId === null ? [] : (settings.pluginSurfaces[input.projectId] ?? [])),
    [input.projectId, settings.pluginSurfaces],
  );

  const serverUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;

  const openPlugin = useCallback(
    (entry: PluginSurfaceEntry, threadRef: ScopedThreadRef) => {
      if (input.projectId === null || serverUrl === null) return;
      void openPluginSurface({
        entry,
        threadRef,
        projectId: input.projectId,
        serverUrl,
        issueCode: issueCode as never,
        openPreview,
      });
    },
    [input.projectId, issueCode, openPreview, serverUrl],
  );

  /** Returns null when the fetch could not run at all, so the dialog can say so. */
  const inspect = useCallback(
    async (url: string): Promise<PluginSurfaceInspection | null> => {
      const result = await inspectCommand({
        environmentId: input.environmentId,
        input: { url },
      });
      return result._tag === "Success" ? result.value : null;
    },
    [input.environmentId, inspectCommand],
  );

  return { entries, openPlugin, inspect, ready: serverUrl !== null };
}
