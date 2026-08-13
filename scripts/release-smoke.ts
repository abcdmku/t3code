// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/mobile/package.json",
  "apps/mobile/deps/react-native-nitro-markdown-0.5.0.tgz",
  "apps/mobile/modules/t3-markdown-text/package.json",
  "apps/mobile/modules/t3-review-diff/package.json",
  "apps/mobile/modules/t3-terminal/package.json",
  "apps/marketing/package.json",
  "infra/relay/package.json",
  "oxlint-plugin-t3code/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/sdk/package.json",
  "packages/shared/package.json",
  "packages/ssh/package.json",
  "packages/tailscale/package.json",
  "packages/ui/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
] as const;

const integrationPackageDirectories = [
  "packages/contracts",
  "packages/sdk",
  "packages/ui",
] as const;

const integrationPackageImports = [
  "@t3tools/contracts/integration",
  "@t3tools/sdk",
  "@t3tools/sdk/effect",
  "@t3tools/sdk/unstable",
  "@t3tools/ui/button",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = NodePath.resolve(repoRoot, relativePath);
    const destinationPath = NodePath.resolve(targetRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath);
  }

  const patchesDirectory = NodePath.resolve(repoRoot, "patches");
  if (NodeFS.existsSync(patchesDirectory)) {
    NodeFS.cpSync(patchesDirectory, NodePath.resolve(targetRoot, "patches"), { recursive: true });
  }
}

function copyIntegrationPackageFixture(targetRoot: string): void {
  copyWorkspaceManifestFixture(targetRoot);
  NodeFS.cpSync(
    NodePath.resolve(repoRoot, "tsconfig.base.json"),
    NodePath.resolve(targetRoot, "tsconfig.base.json"),
  );

  const workspacePath = NodePath.resolve(targetRoot, "pnpm-workspace.yaml");
  const workspaceYaml = NodeFS.readFileSync(workspacePath, "utf8");
  const integrationWorkspaceYaml = workspaceYaml.replace(
    /packages:\r?\n(?:  - [^\r\n]+\r?\n)+/u,
    `packages:
  - packages/contracts
  - packages/sdk
  - packages/ui
`,
  );
  if (integrationWorkspaceYaml === workspaceYaml) {
    throw new Error("Could not limit the integration package fixture workspace.");
  }
  NodeFS.writeFileSync(workspacePath, `${integrationWorkspaceYaml}\nallowUnusedPatches: true\n`);

  for (const packageDirectory of integrationPackageDirectories) {
    const sourcePath = NodePath.resolve(repoRoot, packageDirectory);
    const destinationPath = NodePath.resolve(targetRoot, packageDirectory);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath, {
      recursive: true,
      filter: (path) => !["dist", "node_modules", ".vite-plus"].includes(NodePath.basename(path)),
    });

    assertMissing(
      NodePath.resolve(targetRoot, packageDirectory, "dist"),
      `Integration package fixture copied stale output from ${packageDirectory}.`,
    );
  }
}

function executableName(command: string): string {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function shellPath(path: string): string {
  return path.replaceAll("\\", "/");
}

const pnpmScript = process.env.npm_execpath;
if (pnpmScript === undefined) {
  throw new Error("Run release:smoke through pnpm.");
}

function runVp(cwd: string, args: ReadonlyArray<string>): void {
  NodeChildProcess.execFileSync(process.execPath, [pnpmScript, "exec", "vp", ...args], {
    cwd,
    stdio: "inherit",
  });
}

function packIntegrationPackage(
  fixtureRoot: string,
  tarballDirectory: string,
  packageDirectory: (typeof integrationPackageDirectories)[number],
): string {
  const before = new Set(NodeFS.readdirSync(tarballDirectory));
  runVp(NodePath.resolve(fixtureRoot, packageDirectory), [
    "pm",
    "pack",
    "--pack-destination",
    tarballDirectory,
  ]);
  const createdTarballs = NodeFS.readdirSync(tarballDirectory).filter(
    (fileName) => fileName.endsWith(".tgz") && !before.has(fileName),
  );

  if (createdTarballs.length !== 1) {
    throw new Error(`Expected ${packageDirectory} to produce one tarball.`);
  }

  return NodePath.resolve(tarballDirectory, createdTarballs[0]!);
}

function readPackageJson(path: string): Record<string, unknown> {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collectExportTargets(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(collectExportTargets);
}

function assertInstalledIntegrationPackage(
  consumerRoot: string,
  packageName: "@t3tools/contracts" | "@t3tools/sdk" | "@t3tools/ui",
): void {
  const packageDirectory = NodePath.resolve(consumerRoot, "node_modules", packageName);
  const manifestPath = NodePath.resolve(packageDirectory, "package.json");
  const manifestText = NodeFS.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as {
    readonly version?: unknown;
    readonly exports?: unknown;
    readonly dependencies?: Record<string, unknown>;
  };

  if (manifest.version !== "9.9.9-smoke.0") {
    throw new Error(`${packageName} has the wrong installed version.`);
  }
  if (manifestText.includes("workspace:") || manifestText.includes("catalog:")) {
    throw new Error(`${packageName} contains an unresolved workspace dependency.`);
  }
  assertMissing(
    NodePath.resolve(packageDirectory, "src"),
    `${packageName} unexpectedly includes source files.`,
  );
  for (const target of collectExportTargets(manifest.exports)) {
    if (target !== "./theme.css" && !target.startsWith("./dist/")) {
      throw new Error(`${packageName} export '${target}' does not use built output.`);
    }
  }
  if (
    packageName === "@t3tools/sdk" &&
    manifest.dependencies?.["@t3tools/contracts"] !== "9.9.9-smoke.0"
  ) {
    throw new Error("The packed SDK does not require its matching contracts version.");
  }
}

function smokeIntegrationPackages(fixtureRoot: string, consumerRoot: string): void {
  copyIntegrationPackageFixture(fixtureRoot);
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      fixtureRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  NodeFS.rmSync(NodePath.resolve(fixtureRoot, "pnpm-lock.yaml"), { force: true });
  runVp(fixtureRoot, ["install", "--ignore-scripts"]);

  for (const packageDirectory of integrationPackageDirectories) {
    assertPackageVersion(
      NodePath.resolve(fixtureRoot, packageDirectory, "package.json"),
      "9.9.9-smoke.0",
    );
    runVp(fixtureRoot, [
      "run",
      "--filter",
      JSON.parse(
        NodeFS.readFileSync(
          NodePath.resolve(fixtureRoot, packageDirectory, "package.json"),
          "utf8",
        ),
      ).name as string,
      "build",
    ]);
    assertExists(
      NodePath.resolve(fixtureRoot, packageDirectory, "dist"),
      `${packageDirectory} did not create dist output.`,
    );
  }

  const tarballDirectory = NodePath.resolve(fixtureRoot, "tarballs");
  NodeFS.mkdirSync(tarballDirectory, { recursive: true });
  const tarballs = integrationPackageDirectories.map((packageDirectory) =>
    packIntegrationPackage(fixtureRoot, tarballDirectory, packageDirectory),
  );

  NodeFS.mkdirSync(consumerRoot, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.resolve(consumerRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  const uiManifest = readPackageJson(NodePath.resolve(fixtureRoot, "packages/ui/package.json")) as {
    readonly devDependencies?: Record<string, string>;
  };
  const reactTypes = uiManifest.devDependencies?.["@types/react"];
  const reactDomTypes = uiManifest.devDependencies?.["@types/react-dom"];
  if (reactTypes === undefined || reactDomTypes === undefined) {
    throw new Error("The UI package must pin React types for the external package smoke.");
  }

  NodeChildProcess.execFileSync(
    executableName("npm"),
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...tarballs,
      `@types/react@${reactTypes}`,
      `@types/react-dom@${reactDomTypes}`,
    ],
    {
      cwd: consumerRoot,
      shell: process.platform === "win32",
      stdio: "inherit",
    },
  );

  for (const packageName of ["@t3tools/contracts", "@t3tools/sdk", "@t3tools/ui"] as const) {
    assertInstalledIntegrationPackage(consumerRoot, packageName);
  }

  NodeFS.writeFileSync(
    NodePath.resolve(consumerRoot, "smoke.mjs"),
    `import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const contracts = await import("@t3tools/contracts/integration");
const sdk = await import("@t3tools/sdk");
const effectSdk = await import("@t3tools/sdk/effect");
const unstableSdk = await import("@t3tools/sdk/unstable");
const ui = await import("@t3tools/ui/button");

for (const [entry, exports] of ${JSON.stringify(integrationPackageImports)}.map((entry, index) => [
  entry,
  [contracts, sdk, effectSdk, unstableSdk, ui][index],
])) {
  if (Object.keys(exports).length === 0) {
    throw new Error(\`\${entry} has no runtime exports.\`);
  }
}

if (!("ThreadId" in contracts) || !("createT3Client" in sdk) || !("layer" in effectSdk)) {
  throw new Error("An SDK package entry is missing its main export.");
}
if (!("Button" in ui)) {
  throw new Error("The UI button entry is missing Button.");
}

await access(fileURLToPath(import.meta.resolve("@t3tools/ui/theme.css")));
`,
  );
  NodeChildProcess.execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: consumerRoot,
    stdio: "inherit",
  });

  NodeFS.writeFileSync(
    NodePath.resolve(consumerRoot, "smoke.ts"),
    `import { ThreadId } from "@t3tools/contracts/integration";
import { createT3Client } from "@t3tools/sdk";
import { layer } from "@t3tools/sdk/effect";
import * as unstable from "@t3tools/sdk/unstable";
import { Button } from "@t3tools/ui/button";

void [ThreadId, createT3Client, layer, unstable, Button];
`,
  );
  NodeFS.writeFileSync(
    NodePath.resolve(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2024", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2024",
        },
        files: ["smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const tsgoPath = NodePath.resolve(
    fixtureRoot,
    "node_modules/.bin",
    process.platform === "win32" ? "tsgo.cmd" : "tsgo",
  );
  NodeChildProcess.execFileSync(tsgoPath, ["--project", "tsconfig.json"], {
    cwd: consumerRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "latest-mac.yml");
  const x64Path = NodePath.resolve(assetDirectory, "latest-mac-x64.yml");

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: T3-Code-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: T3-Code-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: T3-Code-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: T3-Code-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsManifestFixtures(
  targetRoot: string,
  channel: string,
): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, `${channel}-win-arm64.yml`);
  const x64Path = NodePath.resolve(assetDirectory, `${channel}-win-x64.yml`);

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-arm64.exe
    sha512: arm64exe
    size: 126621344
  - url: T3-Code-9.9.9-smoke.0-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 152344
path: T3-Code-9.9.9-smoke.0-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-x64.exe
    sha512: x64exe
    size: 132000112
  - url: T3-Code-9.9.9-smoke.0-x64.exe.blockmap
    sha512: x64blockmap
    size: 160112
path: T3-Code-9.9.9-smoke.0-x64.exe
sha512: x64exe
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsBuilderDebugFixtures(targetRoot: string): {
  arm64Path: string;
  x64Path: string;
} {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "builder-debug-win-arm64.yml");
  const x64Path = NodePath.resolve(assetDirectory, "builder-debug-win-x64.yml");
  const debugFixture = `arm64:
  firstOrDefaultFilePatterns:
    - '**/*'
nsis:
  script: |-
    !include "example.nsh"
`;

  NodeFS.writeFileSync(arm64Path, debugFixture);
  NodeFS.writeFileSync(x64Path, debugFixture);

  return { arm64Path, x64Path };
}
function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertExists(path: string, message: string): void {
  if (!NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

function assertPackageVersion(path: string, version: string): void {
  const packageJson = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    readonly version?: unknown;
  };

  if (packageJson.version !== version) {
    throw new Error(`Expected ${path} to have version ${version}.`);
  }
}

function assertMissing(path: string, message: string): void {
  if (NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-smoke-"));
const integrationFixtureRoot = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "t3-integration-release-smoke-"),
);
const integrationConsumerRoot = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "t3-integration-consumer-smoke-"),
);

try {
  copyWorkspaceManifestFixture(tempRoot);

  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  NodeFS.rmSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), { force: true });

  NodeChildProcess.execFileSync(
    process.execPath,
    [pnpmScript, "install", "--lockfile-only", "--ignore-scripts"],
    {
      cwd: tempRoot,
      stdio: "inherit",
    },
  );

  const lockfile = NodeFS.readFileSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), "utf8");
  assertContains(lockfile, "lockfileVersion:", "Expected pnpm-lock.yaml to be regenerated.");

  for (const relativePath of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
    "packages/sdk/package.json",
    "packages/ui/package.json",
  ]) {
    assertPackageVersion(NodePath.resolve(tempRoot, relativePath), "9.9.9-smoke.0");
  }

  const nightlyReleaseMetadata = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      "20260413",
      "--run-number",
      "321",
      "--sha",
      "abcdef1234567890",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assertContains(
    nightlyReleaseMetadata,
    "version=9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly version.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "tag=v9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly tag.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "name=T3 Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    "Expected nightly metadata to include the short commit SHA in the release name.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"),
      "--platform",
      "mac",
      arm64Path,
      x64Path,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = NodeFS.readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "T3-Code-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "T3-Code-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  const { arm64Path: winArm64Path, x64Path: winX64Path } = writeWindowsManifestFixtures(
    tempRoot,
    "latest",
  );
  const mergedWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/latest.yml");
  const { arm64Path: nightlyWinArm64Path, x64Path: nightlyWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "nightly");
  const mergedNightlyWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/nightly.yml");
  const { arm64Path: previewWinArm64Path, x64Path: previewWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "preview");
  const mergedPreviewWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/preview.yml");
  const { arm64Path: winDebugArm64Path, x64Path: winDebugX64Path } =
    writeWindowsBuilderDebugFixtures(tempRoot);
  if (process.platform === "win32") {
    for (const [arm64Manifest, x64Manifest, outputManifest] of [
      [winArm64Path, winX64Path, mergedWindowsManifestPath],
      [nightlyWinArm64Path, nightlyWinX64Path, mergedNightlyWindowsManifestPath],
      [previewWinArm64Path, previewWinX64Path, mergedPreviewWindowsManifestPath],
    ] as const) {
      NodeChildProcess.execFileSync(
        process.execPath,
        [
          NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"),
          "--platform",
          "win",
          arm64Manifest,
          x64Manifest,
          outputManifest,
        ],
        { cwd: repoRoot, stdio: "inherit" },
      );
      NodeFS.rmSync(arm64Manifest);
      NodeFS.rmSync(x64Manifest);
    }
  } else {
    NodeChildProcess.execFileSync(
      "bash",
      [
        "-lc",
        `
        release_assets_dir=${JSON.stringify(shellPath(NodePath.resolve(tempRoot, "release-assets")))}
        shopt -s nullglob
        found_windows_manifest=false
        for x64_manifest in "$release_assets_dir"/*-win-x64.yml; do
          if [[ "$(basename "$x64_manifest")" == builder-debug-* ]]; then
            continue
          fi

          arm64_manifest="\${x64_manifest/-x64.yml/-arm64.yml}"
          output_manifest="\${x64_manifest/-win-x64.yml/.yml}"
          if [[ ! -f "$arm64_manifest" ]]; then
            echo "Missing matching arm64 Windows manifest for $x64_manifest" >&2
            exit 1
          fi

          found_windows_manifest=true
          ${JSON.stringify(shellPath(process.execPath))} ${JSON.stringify(shellPath(NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts")))} --platform win \
            "$arm64_manifest" \
            "$x64_manifest" \
            "$output_manifest"
          rm -f "$arm64_manifest" "$x64_manifest"
        done

        if [[ "$found_windows_manifest" != true ]]; then
          echo "No Windows updater manifests found to merge." >&2
          exit 1
        fi
        `,
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
  }

  const mergedWindowsManifest = NodeFS.readFileSync(mergedWindowsManifestPath, "utf8");
  assertContains(
    mergedWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged Windows manifest is missing the x64 asset.",
  );
  const mergedNightlyWindowsManifest = NodeFS.readFileSync(
    mergedNightlyWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged nightly Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged nightly Windows manifest is missing the x64 asset.",
  );
  const mergedPreviewWindowsManifest = NodeFS.readFileSync(
    mergedPreviewWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged preview Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged preview Windows manifest is missing the x64 asset.",
  );
  assertMissing(
    winArm64Path,
    "Windows release smoke unexpectedly kept the arm64 updater manifest.",
  );
  assertMissing(winX64Path, "Windows release smoke unexpectedly kept the x64 updater manifest.");
  assertMissing(
    nightlyWinArm64Path,
    "Windows release smoke unexpectedly kept the nightly arm64 updater manifest.",
  );
  assertMissing(
    nightlyWinX64Path,
    "Windows release smoke unexpectedly kept the nightly x64 updater manifest.",
  );
  assertMissing(
    previewWinArm64Path,
    "Windows release smoke unexpectedly kept the preview arm64 updater manifest.",
  );
  assertMissing(
    previewWinX64Path,
    "Windows release smoke unexpectedly kept the preview x64 updater manifest.",
  );
  assertExists(
    winDebugArm64Path,
    "Windows release smoke unexpectedly removed the arm64 builder debug fixture.",
  );
  assertExists(
    winDebugX64Path,
    "Windows release smoke unexpectedly removed the x64 builder debug fixture.",
  );

  smokeIntegrationPackages(integrationFixtureRoot, integrationConsumerRoot);

  Effect.runSync(Console.log("Release smoke checks passed."));
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  NodeFS.rmSync(integrationFixtureRoot, { recursive: true, force: true });
  NodeFS.rmSync(integrationConsumerRoot, { recursive: true, force: true });
}
