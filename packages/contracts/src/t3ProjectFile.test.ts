import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile", () => {
  it("decodes a full project file", () => {
    const decoded = decode({
      $schema: "https://t3.codes/schema/t3.json",
      iconPath: "assets/logo.svg",
      scripts: [
        {
          name: "Dev",
          command: "pnpm dev",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://localhost:3000",
          autoOpenPreview: true,
        },
        { name: "Test", command: "pnpm test" },
      ],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts).toHaveLength(2);
    expect(decoded.scripts?.[1]).toEqual({ name: "Test", command: "pnpm test" });
  });

  it("decodes an empty object and ignores unknown fields", () => {
    expect(decode({})).toEqual({});
    expect(decode({ futureField: true })).toEqual({});
  });

  it("decodes custom project surfaces", () => {
    const decoded = decode({
      surfaces: [
        {
          name: "Sketch",
          icon: "play",
          url: "http://127.0.0.1:4820/",
          threadUrl: "http://127.0.0.1:4820/threads/{threadId}",
        },
        { name: "Sketch", url: "https://app.example/projects/{projectId}" },
      ],
    });

    expect(decoded.surfaces).toEqual([
      {
        name: "Sketch",
        icon: "play",
        url: "http://127.0.0.1:4820/",
        threadUrl: "http://127.0.0.1:4820/threads/{threadId}",
      },
      { name: "Sketch", url: "https://app.example/projects/{projectId}" },
    ]);
  });

  it("trims surface fields", () => {
    expect(
      decode({ surfaces: [{ name: " Sketch ", url: " http://127.0.0.1:4820/ " }] }).surfaces?.[0],
    ).toEqual({ name: "Sketch", url: "http://127.0.0.1:4820/" });
  });

  it("drops invalid surface entries without dropping the file", () => {
    const decoded = decode({
      scripts: [{ name: "Dev", command: "pnpm dev" }],
      surfaces: [
        { name: "Missing URL" },
        { name: "Board", url: "http://127.0.0.1:5000/" },
        "not-an-object",
      ],
    });

    expect(decoded.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
    expect(decoded.surfaces).toEqual([{ name: "Board", url: "http://127.0.0.1:5000/" }]);
  });

  it("drops surface entries with URLs longer than the preview contract allows", () => {
    expect(
      decode({
        surfaces: [
          { name: "Too long", url: `https://example.com/${"x".repeat(2048)}` },
          { name: "Board", url: "http://127.0.0.1:5000/" },
        ],
      }).surfaces,
    ).toEqual([{ name: "Board", url: "http://127.0.0.1:5000/" }]);
  });

  it("trims icon paths and script fields", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
      scripts: [{ name: " Dev ", command: " pnpm dev " }],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("rejects scripts without a command", () => {
    expect(() => decode({ scripts: [{ name: "Dev" }] })).toThrow();
  });

  it("rejects unknown script icons", () => {
    expect(() =>
      decode({ scripts: [{ name: "Dev", command: "pnpm dev", icon: "rocket" }] }),
    ).toThrow();
  });

  it("decodes defaultThreadEnvMode and rejects unknown modes", () => {
    expect(decode({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe("worktree");
    expect(decode({ defaultThreadEnvMode: "local" }).defaultThreadEnvMode).toBe("local");
    expect(() => decode({ defaultThreadEnvMode: "remote" })).toThrow();
  });
});
