import { defineConfig } from "vitest/config";

/**
 * Two projects:
 *  - unit:        pure logic, no external services (runs everywhere, fast)
 *  - integration: needs PostgreSQL (DATABASE_URL_TEST or derived from DATABASE_URL) and FFmpeg
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["packages/*/src/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"],
          globalSetup: ["./test/integration-global-setup.ts"],
          setupFiles: ["./test/integration-setup.ts"],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
