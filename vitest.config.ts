import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    reporters: ['default'],
    // Tests must never append to the operational log file or write backups into
    // the real data directory; each run gets its own throwaway directory.
    env: { TICKETS_DATA_DIR: path.resolve('test-results/vitest-data') },
  },
});
