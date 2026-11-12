import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'contract', include: ['test/contract/**/*.test.ts'] } },
      { extends: true, test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'] } },
      {
        extends: true,
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'viewer',
          include: ['test/viewer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['test/viewer/setup.ts'],
          // Class names stay as written, so tests can name the class of a verdict.
          css: { include: /\.css$/, modules: { classNameStrategy: 'non-scoped' } },
        },
      },
    ],
  },
});
