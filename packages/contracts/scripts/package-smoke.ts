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
const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-contracts-smoke-"));
const pnpmScript = process.env.npm_execpath;

if (pnpmScript === undefined) {
  throw new Error("Run this check through pnpm so it can reuse the configured pnpm version.");
}

const runPnpm = (arguments_: ReadonlyArray<string>, cwd: string) =>
  NodeChildProcess.execFileSync(process.execPath, [pnpmScript, ...arguments_], {
    cwd,
    stdio: "inherit",
  });

const packageJson = JSON.parse(
  NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
) as { readonly peerDependencies?: { readonly effect?: string } };
const effectVersion = packageJson.peerDependencies?.effect;
if (effectVersion === undefined || effectVersion === "catalog:") {
  throw new Error("The Effect peer must use the resolved catalog version before packing.");
}

try {
  runPnpm(["exec", "vp", "pack"], packageRoot);
  runPnpm(["pack", "--pack-destination", tempRoot], packageRoot);

  const tarball = NodeFS.readdirSync(tempRoot).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("pnpm pack did not create a contracts tarball.");
  }

  const packOutput = NodeChildProcess.execFileSync(
    "tar",
    ["-xOf", NodePath.join(tempRoot, tarball), "package/package.json"],
    { encoding: "utf8" },
  );
  if (packOutput.includes("workspace:") || packOutput.includes("catalog:")) {
    throw new Error("The packed contracts manifest contains a workspace-only version token.");
  }
  const packedManifest = JSON.parse(packOutput) as {
    readonly exports?: Record<string, unknown>;
  };
  const exportPaths = Object.keys(packedManifest.exports ?? {}).sort();
  const expectedExports = ["./integration", "./integration/unstable"];
  if (JSON.stringify(exportPaths) !== JSON.stringify(expectedExports)) {
    throw new Error(`Unexpected packed exports: ${exportPaths.join(", ")}`);
  }

  const consumerRoot = NodePath.join(tempRoot, "consumer");
  NodeFS.mkdirSync(consumerRoot);
  NodeFS.writeFileSync(
    NodePath.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        type: "module",
        private: true,
        dependencies: {
          "@t3tools/contracts": `file:${NodePath.join(tempRoot, tarball)}`,
          effect: effectVersion,
        },
      },
      null,
      2,
    )}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(consumerRoot, "smoke.mjs"),
    `import { ThreadId } from "@t3tools/contracts/integration";\n` +
      `import { IntegrationWsRpcGroup } from "@t3tools/contracts/integration/unstable";\n` +
      `if (ThreadId.make("thread-1") !== "thread-1") throw new Error("ThreadId import failed");\n` +
      `if (!IntegrationWsRpcGroup) throw new Error("RPC import failed");\n`,
  );

  runPnpm(["install", "--ignore-scripts"], consumerRoot);
  NodeChildProcess.execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: consumerRoot,
    stdio: "inherit",
  });
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
