import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries, and the split is load-bearing rather than cosmetic: the
  // browser entry has no code path that accepts an API key, so shipping one to
  // the browser is a type error instead of a leak.
  entry: { index: "src/index.ts", browser: "src/browser.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "node22",
});
