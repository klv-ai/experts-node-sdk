import { defineConfig } from "vitest/config";

// Integration tests against a real install. Gated on EXPERTS_TEST_KEY so a
// plain `npm test` never needs a stack, while CI can assert real response
// SHAPES — drift from the Python services then fails here rather than at a
// customer.
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
