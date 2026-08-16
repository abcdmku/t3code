import { describe, expect, it } from "vite-plus/test";

import { parsePluginPageMetadata, suggestPluginSurfaceName } from "./pageMetadata.ts";

const PAGE_URL = "https://plugin.test/panel/index.html";

describe("parsePluginPageMetadata", () => {
  it("reads title, description, and icon from the head", () => {
    const metadata = parsePluginPageMetadata(
      `<html><head>
        <title>My Panel</title>
        <meta name="description" content="Does a thing.">
        <link rel="icon" href="/icon.png">
      </head><body></body></html>`,
      PAGE_URL,
    );

    expect(metadata).toEqual({
      title: "My Panel",
      description: "Does a thing.",
      faviconUrl: "https://plugin.test/icon.png",
    });
  });

  it("prefers og:description over the plain description meta", () => {
    const metadata = parsePluginPageMetadata(
      `<head>
        <meta name="description" content="Plain.">
        <meta property="og:description" content="Shared.">
      </head>`,
      PAGE_URL,
    );

    expect(metadata.description).toBe("Shared.");
  });

  it("collapses whitespace and decodes entities", () => {
    const metadata = parsePluginPageMetadata(
      `<head><title>  My   &amp;  Panel
      </title></head>`,
      PAGE_URL,
    );

    expect(metadata.title).toBe("My & Panel");
  });

  it("resolves a relative icon against the page URL, not the origin root", () => {
    const metadata = parsePluginPageMetadata(
      `<head><link rel="icon" href="icon.png"></head>`,
      PAGE_URL,
    );

    expect(metadata.faviconUrl).toBe("https://plugin.test/panel/icon.png");
  });

  it("falls back to /favicon.ico when the page declares no icon", () => {
    expect(parsePluginPageMetadata("<head></head>", PAGE_URL).faviconUrl).toBe(
      "https://plugin.test/favicon.ico",
    );
  });

  it("takes the last icon link, conventionally the largest", () => {
    const metadata = parsePluginPageMetadata(
      `<head>
        <link rel="icon" href="/small.png" sizes="16x16">
        <link rel="apple-touch-icon" href="/apple.png">
        <link rel="shortcut icon" href="/large.png" sizes="192x192">
      </head>`,
      PAGE_URL,
    );

    expect(metadata.faviconUrl).toBe("https://plugin.test/large.png");
  });

  it("ignores content past </head>, so body copy cannot pose as metadata", () => {
    const metadata = parsePluginPageMetadata(
      `<head><title>Real</title></head><body><title>Fake</title>
       <meta name="description" content="Injected."></body>`,
      PAGE_URL,
    );

    expect(metadata.title).toBe("Real");
    expect(metadata.description).toBeUndefined();
  });

  it("returns nothing usable for an empty document", () => {
    const metadata = parsePluginPageMetadata("", PAGE_URL);

    expect(metadata.title).toBeUndefined();
    expect(metadata.description).toBeUndefined();
  });

  it("truncates an overlong title rather than storing it whole", () => {
    const metadata = parsePluginPageMetadata(
      `<head><title>${"a".repeat(500)}</title></head>`,
      PAGE_URL,
    );

    expect(metadata.title).toHaveLength(200);
  });

  it("handles single-quoted and unquoted attributes", () => {
    const metadata = parsePluginPageMetadata(
      `<head><meta name='description' content='Single.'><link rel=icon href=/u.png></head>`,
      PAGE_URL,
    );

    expect(metadata.description).toBe("Single.");
    expect(metadata.faviconUrl).toBe("https://plugin.test/u.png");
  });
});

describe("suggestPluginSurfaceName", () => {
  it.each([
    ["https://plugin.test/panel", "plugin-test"],
    ["https://www.Plugin.Test/panel", "plugin-test"],
    ["http://localhost:5173/panel", "localhost"],
    ["https://my_app.example.test", "my-app-example-test"],
  ])("suggests a tool-safe name for %s", (url, expected) => {
    expect(suggestPluginSurfaceName(url)).toBe(expected);
  });

  it("returns null when the URL is unusable", () => {
    expect(suggestPluginSurfaceName("not a url")).toBeNull();
  });

  it("never ends the suggestion with a hyphen", () => {
    expect(suggestPluginSurfaceName("https://a--.test")?.endsWith("-")).toBe(false);
  });
});
