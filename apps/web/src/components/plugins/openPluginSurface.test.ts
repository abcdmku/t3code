import {
  readPluginSurfaceHandoffFragment,
  type PluginSurfaceEntry,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetPreviewStateForTests } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { openPluginSurface } from "./openPluginSurface";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const entry = (overrides: Partial<PluginSurfaceEntry> = {}): PluginSurfaceEntry => ({
  name: "my-plugin",
  url: "https://plugin.test/t/{threadId}",
  scopes: ["orchestration:read"],
  presentation: {},
  ...overrides,
});

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const run = (options?: { readonly entry?: PluginSurfaceEntry; readonly issueFails?: boolean }) => {
  const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));
  const issueCode = vi.fn(
    async (_request: {
      readonly environmentId: string;
      readonly input: {
        readonly url: string;
        readonly label: string;
        readonly scopes: ReadonlyArray<string>;
      };
    }) =>
      options?.issueFails
        ? AsyncResult.failure(Cause.fail(new Error("no-grant")))
        : AsyncResult.success({ code: "ONETIMECODE", expiresAt: "2026-08-15T00:01:00.000Z" }),
  );
  const result = openPluginSurface({
    entry: options?.entry ?? entry(),
    threadRef,
    projectId: "project-1",
    serverUrl: "http://127.0.0.1:3000",
    issueCode: issueCode as never,
    openPreview: ({ input }) => openPreview(input),
  });
  return { openPreview, issueCode, result };
};

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("openPluginSurface", () => {
  it("resolves the template and opens the browser surface at the handed-off URL", async () => {
    const { openPreview, result } = run();
    await result;

    const url = openPreview.mock.calls[0]?.[0]?.url ?? "";
    expect(url.startsWith("https://plugin.test/t/thread-1#")).toBe(true);
    expect(readPluginSurfaceHandoffFragment(new URL(url).hash)).toEqual({
      serverUrl: "http://127.0.0.1:3000",
      code: "ONETIMECODE",
    });
  });

  it("asks the server for a code against the template, not the resolved URL", async () => {
    const { issueCode } = run();
    await issueCode.mock.results[0]?.value;

    expect(issueCode).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        url: "https://plugin.test/t/{threadId}",
        label: "my-plugin",
        scopes: ["orchestration:read"],
      },
    });
  });

  it("opens the browser tab in the right panel on success", async () => {
    const { result } = run();
    await result;

    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.map((surface) => surface.id),
    ).toEqual(["browser:tab-1"]);
  });

  it("never opens a surface when the code is refused", async () => {
    const { openPreview, result } = run({ issueFails: true });
    const settled = await result;

    expect(settled._tag).toBe("Failure");
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("passes the entry's requested scopes through unchanged", async () => {
    const { issueCode } = run({
      entry: entry({ scopes: ["orchestration:read", "orchestration:operate"] }),
    });
    await issueCode.mock.results[0]?.value;

    expect(issueCode.mock.calls[0]?.[0]?.input.scopes).toEqual([
      "orchestration:read",
      "orchestration:operate",
    ]);
  });

  it("substitutes projectId for a template that uses it", async () => {
    const { openPreview, result } = run({
      entry: entry({ url: "https://plugin.test/p/{projectId}" }),
    });
    await result;

    expect(
      openPreview.mock.calls[0]?.[0]?.url?.startsWith("https://plugin.test/p/project-1#"),
    ).toBe(true);
  });
});
