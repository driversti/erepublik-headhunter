import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration tests are explicitly excluded by `npm test`; they run via
    // `npm run test:integration` which loads .env and matches just that file.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: 'verbose',
  },
});
