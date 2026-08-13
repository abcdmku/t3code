import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/integration.ts", "src/integration-unstable.ts"],
    outDir: "dist",
    dts: true,
    clean: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
