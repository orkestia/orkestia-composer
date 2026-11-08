import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** `pnpm dev`: the editor on the fixture backend (harness/). Not part of the library build. */
export default defineConfig({
  root: 'harness',
  plugins: [react()],
  server: { port: 5178 },
  build: { outDir: '../.harness-dist', emptyOutDir: true },
})
