import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/shared/**/*.test.ts',
      'src/client/haptics/**/*.test.ts',
      'tools/**/*.test.mjs',
    ],
    environment: 'node',
  },
});
