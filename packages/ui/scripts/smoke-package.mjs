import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "t3tools-ui-smoke-"));
const packDirectory = join(temporaryDirectory, "pack");
const consumerDirectory = join(temporaryDirectory, "consumer");
const pnpmScript = process.env.npm_execpath;

if (!pnpmScript) {
  throw new Error("Run this check through pnpm so it can reuse the configured pnpm version.");
}

function runPnpm(arguments_, cwd) {
  const result = spawnSync(process.execPath, [pnpmScript, ...arguments_], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`pnpm ${arguments_.join(" ")} failed with exit code ${result.status}`);
  }
}

function exportTargets(value) {
  if (typeof value === "string") {
    return value.startsWith("./") ? [value] : [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(exportTargets);
}

try {
  await mkdir(packDirectory);
  await mkdir(join(consumerDirectory, "src"), { recursive: true });

  runPnpm(["pack", "--pack-destination", packDirectory], packageDirectory);

  const tarballs = (await readdir(packDirectory)).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "pnpm pack should create one tarball");
  const tarballPath = join(packDirectory, tarballs[0]);

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "t3tools-ui-package-smoke",
        private: true,
        type: "module",
        packageManager: "pnpm@11.10.0",
        dependencies: {
          "@base-ui/react": "1.4.1",
          "@t3tools/ui": `file:${tarballPath.replaceAll("\\", "/")}`,
          react: "19.2.6",
          "react-dom": "19.2.6",
          tailwindcss: "4.3.0",
        },
        devDependencies: {
          "@tailwindcss/vite": "4.3.0",
          "@types/node": "24.12.4",
          "@types/react": "19.2.16",
          "@types/react-dom": "19.2.3",
          typescript: "6.0.3",
          vite: "npm:@voidzero-dev/vite-plus-core@0.2.2",
          "vite-plus": "0.2.2",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          strict: true,
          target: "ESNext",
          types: ["node", "vite/client"],
        },
        include: ["src", "vite.config.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerDirectory, "vite.config.ts"),
    `import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [tailwindcss()] });
`,
  );
  await writeFile(
    join(consumerDirectory, "index.html"),
    `<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n`,
  );
  await writeFile(
    join(consumerDirectory, "src", "index.css"),
    `@import "tailwindcss";
@import "@t3tools/ui/theme.css";
@source "../node_modules/@t3tools/ui/dist";
`,
  );
  await writeFile(
    join(consumerDirectory, "src", "main.tsx"),
    `import { createRoot } from "react-dom/client";
import { Button } from "@t3tools/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "@t3tools/ui/dialog";
import "./index.css";

function App() {
  return (
    <Dialog defaultOpen>
      <DialogPopup>
        <DialogTitle>Package smoke test</DialogTitle>
        <Button>Save</Button>
      </DialogPopup>
    </Dialog>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
  );

  runPnpm(["install", "--prefer-offline", "--ignore-scripts"], consumerDirectory);

  const installedPackageDirectory = join(consumerDirectory, "node_modules", "@t3tools", "ui");
  const installedManifest = JSON.parse(
    await readFile(join(installedPackageDirectory, "package.json"), "utf8"),
  );

  for (const target of exportTargets(installedManifest.exports)) {
    await readFile(join(installedPackageDirectory, target), "utf8");
  }

  const buttonModule = await readFile(
    join(installedPackageDirectory, "dist", "button.mjs"),
    "utf8",
  );
  assert.match(buttonModule, /^"use client";/, "the packed Button must keep its client directive");

  runPnpm(["exec", "tsc", "--noEmit"], consumerDirectory);
  runPnpm(["exec", "vp", "build"], consumerDirectory);

  const builtAssetsDirectory = join(consumerDirectory, "dist", "assets");
  const builtStylesheets = (await readdir(builtAssetsDirectory)).filter((entry) =>
    entry.endsWith(".css"),
  );
  assert.equal(builtStylesheets.length, 1, "the consumer build should create one stylesheet");
  const builtCss = await readFile(join(builtAssetsDirectory, builtStylesheets[0]), "utf8");
  assert.match(
    builtCss,
    /--control-icon-color:currentColor/,
    "Tailwind must scan classes from the packed Button module",
  );

  process.stdout.write("Packed UI consumer passed typecheck and build.\n");
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
