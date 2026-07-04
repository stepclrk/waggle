import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Suites share one Postgres/Redis and truncate between runs — never parallel.
    fileParallelism: false,
  },
});
