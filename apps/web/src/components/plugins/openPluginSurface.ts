import {
  type AuthEnvironmentScope,
  type PluginSurfaceEntry,
  type PluginSurfaceHandoff,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { attachPluginSurfaceHandoff, resolvePluginSurfaceTemplate } from "~/lib/pluginSurfaceUrl";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "../preview/openPreviewSession";

export type IssuePluginCodeMutation<E> = (input: {
  readonly environmentId: string;
  readonly input: {
    readonly url: string;
    readonly label: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  };
}) => Promise<AtomCommandResult<PluginSurfaceHandoff, E>>;

/**
 * Opens a plugin surface in the browser surface T3 already ships.
 *
 * The order matters. The code is minted after the template resolves, so it is
 * issued against the same URL the page will be opened at, and it is minted per
 * open rather than stored, so a code left behind in history is already dead.
 *
 * Right-panel surfaces are per thread, so each thread opens its own instance
 * of an entry with its own thread id and its own code.
 */
export async function openPluginSurface<E>(input: {
  readonly entry: PluginSurfaceEntry;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: string;
  readonly serverUrl: string;
  readonly issueCode: IssuePluginCodeMutation<E>;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  const resolvedUrl = resolvePluginSurfaceTemplate(input.entry.url, {
    environmentId: input.threadRef.environmentId,
    projectId: input.projectId,
    serverUrl: input.serverUrl,
    threadId: input.threadRef.threadId,
  });

  const handoff = await input.issueCode({
    environmentId: input.threadRef.environmentId,
    input: {
      // The template, not the resolved URL. The server keys consent to the
      // origin, and resolving cannot change it.
      url: input.entry.url,
      label: input.entry.name,
      scopes: input.entry.scopes,
    },
  });
  // Nothing is opened when the server refuses a code, so a plugin whose grant
  // was revoked simply stops working instead of loading unauthenticated.
  if (handoff._tag === "Failure") return mapAtomCommandResult(handoff, () => undefined);

  const url = attachPluginSurfaceHandoff({
    url: resolvedUrl,
    serverUrl: input.serverUrl,
    code: handoff.value.code,
  });

  const opened = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url,
  });
  return mapAtomCommandResult(opened, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
