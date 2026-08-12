import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The database-backed suites share one schema and truncate it between
    // tests, so two files running at once would clear each other's fixtures.
    // Everything here is fast; serialising costs a second and removes a class
    // of failure that only ever shows up as a confusing flake.
    fileParallelism: false,
  },
});
