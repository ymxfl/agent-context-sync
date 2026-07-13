import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Avoid cross-file contention between real Git daemons and filesystem-heavy fixtures.
    fileParallelism: false,
  },
});
