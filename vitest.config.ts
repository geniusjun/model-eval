import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'contract', include: ['test/contract/**/*.test.ts'] } },
      { extends: true, test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'] } },
    ],
  },
});
