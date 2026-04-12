import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/devices/**'],
      exclude: ['src/**/*.spec.ts', 'src/**/index.ts'],
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    conditions: ['node'],
  },
});
