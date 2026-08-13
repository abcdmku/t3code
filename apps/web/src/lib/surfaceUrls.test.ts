import { describe, expect, it } from "vite-plus/test";

import {
  isAllowedSurfaceUrl,
  resolveSurfaceUrlTemplate,
  sanitizeServerUrlForTemplate,
  surfaceEntryKey,
} from "./surfaceUrls";

const context = {
  environmentId: "env-1",
  projectId: "project-1",
  serverUrl: "http://127.0.0.1:3000",
  threadId: "thread-1",
} as const;

describe("resolveSurfaceUrlTemplate", () => {
  it("substitutes every supported placeholder", () => {
    expect(
      resolveSurfaceUrlTemplate(
        "{serverUrl}/bridge?env={environmentId}&project={projectId}&thread={threadId}",
        context,
      ),
    ).toBe("http://127.0.0.1:3000/bridge?env=env-1&project=project-1&thread=thread-1");
  });

  it("substitutes repeated placeholders", () => {
    expect(resolveSurfaceUrlTemplate("http://x/{threadId}/{threadId}", context)).toBe(
      "http://x/thread-1/thread-1",
    );
  });

  it("percent-encodes identifiers so they cannot alter the URL structure", () => {
    expect(
      resolveSurfaceUrlTemplate("http://x/t/{threadId}?p={projectId}#e={environmentId}", {
        environmentId: "env&x=1",
        projectId: "proj?query",
        threadId: "thread/../../admin#frag",
      }),
    ).toBe("http://x/t/thread%2F..%2F..%2Fadmin%23frag?p=proj%3Fquery#e=env%26x%3D1");
  });

  it("strips credentials, query and hash from {serverUrl}", () => {
    expect(
      resolveSurfaceUrlTemplate("{serverUrl}/bridge", {
        environmentId: "env-1",
        projectId: "project-1",
        serverUrl: "https://user:secret@relay.example:8443/base/?token=abc#frag",
      }),
    ).toBe("https://relay.example:8443/base/bridge");
  });

  it("leaves {serverUrl} untouched for a non-http(s) connection URL", () => {
    expect(
      resolveSurfaceUrlTemplate("{serverUrl}/bridge", {
        environmentId: "env-1",
        projectId: "project-1",
        serverUrl: "file:///etc/passwd",
      }),
    ).toBe("{serverUrl}/bridge");
  });

  it("leaves {threadId} untouched without a thread context", () => {
    expect(
      resolveSurfaceUrlTemplate("http://127.0.0.1:4820/threads/{threadId}", {
        environmentId: "env-1",
        projectId: "project-1",
        serverUrl: "http://127.0.0.1:3000",
      }),
    ).toBe("http://127.0.0.1:4820/threads/{threadId}");
  });

  it("leaves {serverUrl} untouched without a prepared connection", () => {
    expect(
      resolveSurfaceUrlTemplate("{serverUrl}/bridge", {
        environmentId: "env-1",
        projectId: "project-1",
      }),
    ).toBe("{serverUrl}/bridge");
  });

  it("leaves unknown placeholders for validation to reject", () => {
    expect(resolveSurfaceUrlTemplate("http://x/{workspaceId}?t={threadId}", context)).toBe(
      "http://x/{workspaceId}?t=thread-1",
    );
  });

  it("returns placeholder-free templates unchanged", () => {
    expect(resolveSurfaceUrlTemplate("http://127.0.0.1:4820/", context)).toBe(
      "http://127.0.0.1:4820/",
    );
  });
});

describe("sanitizeServerUrlForTemplate", () => {
  it("keeps scheme, host, port and base path", () => {
    expect(sanitizeServerUrlForTemplate("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(sanitizeServerUrlForTemplate("https://relay.example/base/")).toBe(
      "https://relay.example/base",
    );
  });

  it("drops userinfo, query and hash", () => {
    expect(sanitizeServerUrlForTemplate("http://user:pass@host:1234/?token=x#y")).toBe(
      "http://host:1234",
    );
  });

  it("returns null for non-http(s) or unparseable values", () => {
    expect(sanitizeServerUrlForTemplate("javascript:alert(1)")).toBeNull();
    expect(sanitizeServerUrlForTemplate("not a url")).toBeNull();
  });
});

describe("isAllowedSurfaceUrl", () => {
  it("allows http and https URLs", () => {
    expect(isAllowedSurfaceUrl("http://127.0.0.1:4820/")).toBe(true);
    expect(isAllowedSurfaceUrl("https://example.com/app?x=1")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isAllowedSurfaceUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedSurfaceUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isAllowedSurfaceUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects templates whose placeholders never resolved", () => {
    expect(isAllowedSurfaceUrl("{serverUrl}/bridge")).toBe(false);
  });

  it("rejects otherwise-valid absolute URLs still containing a known placeholder", () => {
    expect(isAllowedSurfaceUrl("http://127.0.0.1:4820/threads/{threadId}")).toBe(false);
    expect(isAllowedSurfaceUrl("https://app.example/?p={projectId}")).toBe(false);
    expect(isAllowedSurfaceUrl("https://app.example/#{environmentId}")).toBe(false);
    expect(isAllowedSurfaceUrl("https://app.example/{serverUrl}/bridge")).toBe(false);
  });

  it("rejects known placeholders with percent-encoded braces, any case", () => {
    expect(isAllowedSurfaceUrl("http://127.0.0.1:4820/%7BserverUrl%7D/bridge")).toBe(false);
    expect(isAllowedSurfaceUrl("http://127.0.0.1:4820/%7bserverUrl%7d/bridge")).toBe(false);
    expect(isAllowedSurfaceUrl("https://app.example/threads/%7BthreadId%7D")).toBe(false);
  });

  it("rejects unknown unresolved placeholders", () => {
    expect(isAllowedSurfaceUrl("http://127.0.0.1:4820/{workspaceId}")).toBe(false);
    expect(isAllowedSurfaceUrl("http://127.0.0.1:4820/%7BworkspaceId%7D")).toBe(false);
  });
});

describe("surfaceEntryKey", () => {
  it("distinguishes entries sharing a name", () => {
    const first = surfaceEntryKey({ name: "Sketch", url: "http://127.0.0.1:1/" }, 0);
    const second = surfaceEntryKey({ name: "Sketch", url: "http://127.0.0.1:2/" }, 1);
    expect(first).not.toBe(second);
  });

  it("prefers the thread URL when present", () => {
    expect(
      surfaceEntryKey({ name: "Sketch", url: "http://a/", threadUrl: "http://b/{threadId}" }, 0),
    ).toBe("0:Sketch:http://b/{threadId}");
  });
});
