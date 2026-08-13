import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/effect.ts", "src/unstable.ts"],
    outDir: "dist",
    dts: true,
    clean: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
