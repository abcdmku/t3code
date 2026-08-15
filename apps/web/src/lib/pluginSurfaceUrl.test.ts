import { readPluginSurfaceHandoffFragment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachPluginSurfaceHandoff,
  resolvePluginSurfaceTemplate,
  sanitizeServerUrl,
} from "./pluginSurfaceUrl";

const context = {
  environmentId: "env-1",
  projectId: "project-1",
  serverUrl: "http://127.0.0.1:3000",
  threadId: "thread-1",
};

describe("resolvePluginSurfaceTemplate", () => {
  it("substitutes every placeholder", () => {
    expect(
      resolvePluginSurfaceTemplate(
        "https://plugin.test/{environmentId}/{projectId}/{threadId}?s={serverUrl}",
        context,
      ),
    ).toBe("https://plugin.test/env-1/project-1/thread-1?s=http://127.0.0.1:3000");
  });

  it("leaves {threadId} alone for a project-level open", () => {
    expect(
      resolvePluginSurfaceTemplate("https://plugin.test/t/{threadId}", {
        ...context,
        threadId: undefined,
      }),
    ).toBe("https://plugin.test/t/{threadId}");
  });

  it("percent-encodes ids so one cannot inject path segments", () => {
    expect(
      resolvePluginSurfaceTemplate("https://plugin.test/{projectId}", {
        ...context,
        projectId: "a/../b",
      }),
    ).toBe("https://plugin.test/a%2F..%2Fb");
  });

  it("repeats a placeholder used more than once", () => {
    expect(
      resolvePluginSurfaceTemplate("https://plugin.test/{threadId}?also={threadId}", context),
    ).toBe("https://plugin.test/thread-1?also=thread-1");
  });

  it("leaves the template untouched when it has no placeholders", () => {
    expect(resolvePluginSurfaceTemplate("https://plugin.test/panel", context)).toBe(
      "https://plugin.test/panel",
    );
  });
});

describe("sanitizeServerUrl", () => {
  it("drops credentials, query, and fragment", () => {
    expect(sanitizeServerUrl("http://user:pass@127.0.0.1:3000/base?token=secret#x")).toBe(
      "http://127.0.0.1:3000/base",
    );
  });

  it("drops a trailing slash so joined paths do not double up", () => {
    expect(sanitizeServerUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
  });

  it.each([
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["relative", "/api"],
  ])("rejects a %s base URL", (_label, url) => {
    expect(sanitizeServerUrl(url)).toBeNull();
  });
});

describe("attachPluginSurfaceHandoff", () => {
  it("round-trips through the reader the plugin page uses", () => {
    const url = attachPluginSurfaceHandoff({
      url: "https://plugin.test/panel?thread=thread-1",
      serverUrl: "http://127.0.0.1:3000",
      code: "ONETIMECODE",
    });

    expect(url.startsWith("https://plugin.test/panel?thread=thread-1#")).toBe(true);
    expect(readPluginSurfaceHandoffFragment(new URL(url).hash)).toEqual({
      serverUrl: "http://127.0.0.1:3000",
      code: "ONETIMECODE",
    });
  });

  it("replaces a fragment the template already had, so t3= cannot be spoofed", () => {
    const url = attachPluginSurfaceHandoff({
      url: "https://plugin.test/panel#t3=https%3A%2F%2Fevil.test%7CSTOLEN",
      serverUrl: "http://127.0.0.1:3000",
      code: "REAL",
    });

    expect(readPluginSurfaceHandoffFragment(new URL(url).hash)).toEqual({
      serverUrl: "http://127.0.0.1:3000",
      code: "REAL",
    });
  });

  it("strips a token out of the base URL before handing it over", () => {
    const url = attachPluginSurfaceHandoff({
      url: "https://plugin.test/panel",
      serverUrl: "http://127.0.0.1:3000/?token=secret",
      code: "CODE",
    });

    expect(url).not.toContain("secret");
    expect(readPluginSurfaceHandoffFragment(new URL(url).hash)?.serverUrl).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("returns the URL unchanged when the base URL is unusable", () => {
    expect(
      attachPluginSurfaceHandoff({
        url: "https://plugin.test/panel",
        serverUrl: "not a url",
        code: "CODE",
      }),
    ).toBe("https://plugin.test/panel");
  });
});
