import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The model's tests run in node; UI tests opt into jsdom with a
    // `// @vitest-environment jsdom` line at the top of the file.
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/ui/test-setup.ts'],
    // A page URL, so jsdom provides localStorage.
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
})
