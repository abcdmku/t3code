// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const packageRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const contractsRoot = NodePath.resolve(packageRoot, "../contracts");
const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sdk-smoke-"));
const pnpmScript = process.env.npm_execpath;

if (pnpmScript === undefined) {
  throw new Error("Run this check through pnpm so it can reuse the configured pnpm version.");
}

const runPnpm = (
  arguments_: ReadonlyArray<string>,
  cwd: string,
  stdio: "inherit" | "pipe" = "inherit",
) =>
  NodeChildProcess.execFileSync(process.execPath, [pnpmScript, ...arguments_], {
    cwd,
    encoding: stdio === "pipe" ? "utf8" : undefined,
    stdio,
  });

const readPackedManifest = (tarball: string) => {
  const text = NodeChildProcess.execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8",
  });
  if (text.includes("workspace:") || text.includes("catalog:")) {
    throw new Error(`${NodePath.basename(tarball)} contains a workspace-only version token.`);
  }
  return JSON.parse(text) as {
    readonly exports?: Record<string, unknown>;
    readonly peerDependencies?: { readonly effect?: string };
  };
};

try {
  runPnpm(["pack", "--pack-destination", tempRoot], contractsRoot);
  runPnpm(["pack", "--pack-destination", tempRoot], packageRoot);

  const tarballs = NodeFS.readdirSync(tempRoot).filter((file) => file.endsWith(".tgz"));
  const contractsTarball = tarballs.find((file) => file.includes("contracts"));
  const sdkTarball = tarballs.find((file) => file.includes("sdk"));
  if (contractsTarball === undefined || sdkTarball === undefined) {
    throw new Error("Packing must create one contracts tarball and one SDK tarball.");
  }

  readPackedManifest(NodePath.join(tempRoot, contractsTarball));
  const sdkManifest = readPackedManifest(NodePath.join(tempRoot, sdkTarball));
  const exportPaths = Object.keys(sdkManifest.exports ?? {}).sort();
  const expectedExports = [".", "./effect", "./unstable"];
  if (JSON.stringify(exportPaths) !== JSON.stringify(expectedExports)) {
    throw new Error(`Unexpected packed SDK exports: ${exportPaths.join(", ")}`);
  }
  const effectVersion = sdkManifest.peerDependencies?.effect;
  if (effectVersion === undefined || effectVersion === "catalog:") {
    throw new Error("The packed SDK must declare a resolved Effect peer version.");
  }

  const consumerRoot = NodePath.join(tempRoot, "consumer");
  NodeFS.mkdirSync(consumerRoot);
  const contractsTarballPath = NodePath.join(tempRoot, contractsTarball);
  const sdkTarballPath = NodePath.join(tempRoot, sdkTarball);
  NodeFS.writeFileSync(
    NodePath.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "t3-sdk-package-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@t3tools/contracts": `file:${contractsTarballPath}`,
          "@t3tools/sdk": `file:${sdkTarballPath}`,
          effect: effectVersion,
        },
        devDependencies: { "@types/node": "24.12.4", typescript: "6.0.3" },
      },
      null,
      2,
    )}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(consumerRoot, "pnpm-workspace.yaml"),
    `overrides:\n  '@t3tools/contracts': 'file:${contractsTarballPath.replaceAll("\\", "/")}'\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext", "DOM"],
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ESNext",
          types: ["node"],
        },
        include: ["smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(consumerRoot, "smoke.ts"),
    `import { createT3Client, T3AuthError } from "@t3tools/sdk";\n` +
      `import { layer, shell } from "@t3tools/sdk/effect";\n` +
      `import { dispatch, T3Client } from "@t3tools/sdk/unstable";\n` +
      `void [createT3Client, T3AuthError, layer, shell, dispatch, T3Client];\n`,
  );

  runPnpm(["install", "--ignore-scripts"], consumerRoot);
  runPnpm(["exec", "tsc", "--noEmit"], consumerRoot);
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import("@t3tools/sdk").then((sdk) => { if (typeof sdk.createT3Client !== "function") process.exit(1); })',
    ],
    { cwd: consumerRoot, stdio: "inherit" },
  );
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
