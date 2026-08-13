import type {
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserPreviewUnavailableError } from "~/browser/openFileInPreview";
import {
  applyPreviewServerSnapshot,
  previewStateAtom,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  openProjectSurface,
  SurfaceUrlInvalidError,
  SurfaceUrlUnreachableError,
} from "./openProjectSurface";

const runtime = vi.hoisted(() => ({
  previewSupported: true,
  connection: null as { httpBaseUrl: string } | null,
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection: () => runtime.connection,
}));

vi.mock("~/previewStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/previewStateStore")>()),
  isPreviewSupportedInRuntime: () => runtime.previewSupported,
}));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};
const projectId = "project-1" as ProjectId;

const snapshot = (tabId: string, url?: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: url === undefined ? { _tag: "Idle" } : { _tag: "Success", url, title: "Surface" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-06-18T19:00:0${tabId.at(-1) ?? "0"}.000Z`,
});

const openBrowserSurfaceIds = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces.map(
    (surface) => surface.id,
  );

beforeEach(() => {
  runtime.previewSupported = true;
  runtime.connection = { httpBaseUrl: "http://127.0.0.1:3773" };
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("openProjectSurface", () => {
  it("opens the resolved surface URL in a new preview tab", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1", "https://app.example/dashboard?p=project-1")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "https://app.example/dashboard?p={projectId}",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Success");
    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "https://app.example/dashboard?p=project-1",
    });
    expect(openBrowserSurfaceIds()).toEqual(["browser:tab-1"]);
  });

  it("focuses the already-open tab for the same resolved URL instead of duplicating it", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-1", "http://127.0.0.1:4820"));
    applyPreviewServerSnapshot(threadRef, snapshot("tab-2", "http://127.0.0.1:9999/"));
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-3", "http://127.0.0.1:4820/")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "http://127.0.0.1:4820/",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Success");
    expect(openPreview).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
    expect(openBrowserSurfaceIds()).toEqual(["browser:tab-1"]);
  });

  it("opens a new tab when the only matching tab is suppressed during close", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-1", "http://127.0.0.1:4820/"));
    // `beginPreviewSessionClose` prunes the session synchronously today; forge
    // the transient overlap (session still listed while its close is in
    // flight) that the dedupe scan must not match.
    const atom = previewStateAtom(scopedThreadKey(threadRef));
    appAtomRegistry.set(atom, {
      ...appAtomRegistry.get(atom),
      suppressedTabIds: new Set(["tab-1"]),
    });
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-2", "http://127.0.0.1:4820/")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "http://127.0.0.1:4820/",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Success");
    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "http://127.0.0.1:4820/",
    });
    expect(openBrowserSurfaceIds()).toEqual(["browser:tab-2"]);
  });

  it("strips credentials, query and hash from {serverUrl} before opening", async () => {
    runtime.connection = { httpBaseUrl: "https://user:secret@relay.example:8443/?token=abc#f" };
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1", "https://relay.example:8443/bridge")),
    );

    await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "{serverUrl}/bridge",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "https://relay.example:8443/bridge",
    });
  });

  it("rejects a template resolving to a non-http(s) scheme without opening anything", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "javascript:alert('{projectId}')",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(squashAtomCommandFailure(result)).toBeInstanceOf(SurfaceUrlInvalidError);
    }
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("rejects an unresolved {serverUrl} in the path before normalization can encode it away", async () => {
    runtime.connection = null;
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "http://127.0.0.1:4820/{serverUrl}/bridge",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(squashAtomCommandFailure(result)).toBeInstanceOf(SurfaceUrlInvalidError);
    }
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("does not send a remote loopback URL to the desktop machine", async () => {
    runtime.connection = { httpBaseUrl: "https://relay.example.com" };
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "http://127.0.0.1:4820/",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(squashAtomCommandFailure(result)).toBeInstanceOf(SurfaceUrlUnreachableError);
    }
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("maps loopback onto a private remote host", async () => {
    runtime.connection = { httpBaseUrl: "http://100.65.180.100:3773" };
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1", "http://100.65.180.100:4820/")),
    );

    await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "http://127.0.0.1:4820/",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "http://100.65.180.100:4820/",
    });
  });

  it("rejects a percent-encoded {serverUrl} placeholder in the path", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "http://127.0.0.1:4820/%7BserverUrl%7D/bridge",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(squashAtomCommandFailure(result)).toBeInstanceOf(SurfaceUrlInvalidError);
    }
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("fails when the integrated browser is unavailable in this runtime", async () => {
    runtime.previewSupported = false;
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    const result = await openProjectSurface({
      threadRef,
      projectId,
      urlTemplate: "http://127.0.0.1:4820/",
      openPreview: ({ input }) => openPreview(input),
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(squashAtomCommandFailure(result)).toBeInstanceOf(BrowserPreviewUnavailableError);
    }
    expect(openPreview).not.toHaveBeenCalled();
  });
});
