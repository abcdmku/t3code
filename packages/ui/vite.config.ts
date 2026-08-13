import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/*.ts", "src/*.tsx", "!src/*.test.*"],
    outDir: "dist",
    dts: true,
    clean: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
