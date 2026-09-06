import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The live suite needs a running install and a real key; it is opt-in.
    exclude: ["test/live/**"],
    environment: "node",
  },
});
