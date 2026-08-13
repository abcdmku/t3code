import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import {
  BrowserPreviewUnavailableError,
  openUrlInPreview,
  type OpenPreviewMutation,
} from "~/browser/openFileInPreview";
import { isAllowedSurfaceUrl, resolveSurfaceUrlTemplate } from "~/lib/surfaceUrls";
import {
  isPreviewSupportedInRuntime,
  readThreadPreviewState,
  setActivePreviewTab,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { readPreparedConnection } from "~/state/session";

/** The resolved surface URL was not an openable http(s) URL. */
export class SurfaceUrlInvalidError extends Data.TaggedError("SurfaceUrlInvalidError")<{
  readonly message: string;
}> {}

export class SurfaceUrlUnreachableError extends Data.TaggedError("SurfaceUrlUnreachableError")<{
  readonly message: string;
}> {}

const toComparableUrl = (url: string): string | null => {
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
};

/**
 * The tab already showing `url` in this thread's collaborative browser, if
 * any. Tabs with a close in flight (`suppressedTabIds`) never match: focusing
 * one would target a tab that is about to disappear instead of opening a
 * fresh one.
 */
const findOpenTabForUrl = (threadRef: ScopedThreadRef, url: string): string | null => {
  const target = toComparableUrl(url);
  if (target === null) return null;
  const state = readThreadPreviewState(threadRef);
  for (const session of Object.values(state.sessions)) {
    if (state.suppressedTabIds.has(session.tabId)) continue;
    if (session.navStatus._tag === "Idle") continue;
    if (toComparableUrl(session.navStatus.url) === target) return session.tabId;
  }
  return null;
};

/**
 * Open one custom project surface in the thread preview.
 */
export async function openProjectSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  /** The surface's `url` or `threadUrl`, chosen by the caller. */
  readonly urlTemplate: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<
  AtomCommandResult<
    void,
    E | BrowserPreviewUnavailableError | SurfaceUrlInvalidError | SurfaceUrlUnreachableError
  >
> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const connection = readPreparedConnection(input.threadRef.environmentId);
  const resolved = resolveSurfaceUrlTemplate(input.urlTemplate, {
    environmentId: input.threadRef.environmentId,
    projectId: input.projectId,
    serverUrl: connection?.httpBaseUrl,
    threadId: input.threadRef.threadId,
  });
  if (!isAllowedSurfaceUrl(resolved)) {
    return AsyncResult.failure(
      Cause.fail(
        new SurfaceUrlInvalidError({
          message: "The surface did not resolve to a valid http(s) URL.",
        }),
      ),
    );
  }
  let url: string;
  try {
    url = resolveBrowserNavigationTarget(input.threadRef.environmentId, {
      kind: "url",
      url: resolved,
    }).resolvedUrl;
  } catch (error) {
    return AsyncResult.failure(
      Cause.fail(
        new SurfaceUrlUnreachableError({
          message: error instanceof Error ? error.message : "The surface URL is not reachable.",
        }),
      ),
    );
  }
  if (!isAllowedSurfaceUrl(url)) {
    return AsyncResult.failure(
      Cause.fail(
        new SurfaceUrlInvalidError({
          message: "The surface did not resolve to a valid http(s) URL.",
        }),
      ),
    );
  }
  const existingTabId = findOpenTabForUrl(input.threadRef, url);
  if (existingTabId !== null) {
    setActivePreviewTab(input.threadRef, existingTabId);
    useRightPanelStore.getState().openBrowser(input.threadRef, existingTabId);
    return AsyncResult.success(undefined);
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url,
    openPreview: input.openPreview,
  });
}
