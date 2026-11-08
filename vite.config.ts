import { copyFileSync, mkdirSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import dts from 'vite-plugin-dts'
import { fileURLToPath } from 'node:url'

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

/**
 * Library build.
 *   dist/index.js          root entry: the React editor
 *   dist/style.css         the editor's stylesheet (src/ui/styles.css, copied as is)
 *   dist/model.js          @orkestia/composer/model, pure TypeScript
 *   dist/**\/*.d.ts         the type surface, one file per module
 */
export default defineConfig({
  plugins: [
    copyStyles(),
    dts({
      tsconfigPath: './tsconfig.build.json',
      entryRoot: 'src',
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__fixtures__/**', 'src/ui/fixtures.ts', 'src/**/*.test-utils.tsx'],
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: { index: src('index.ts'), model: src('model/index.ts') },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@xyflow/react', 'dagre'],
    },
  },
})

/** The stylesheet ships as written: no CSS pipeline, so hosts get exactly src/ui/styles.css. */
function copyStyles(): Plugin {
  return {
    name: 'copy-styles',
    apply: 'build',
    closeBundle() {
      mkdirSync('dist', { recursive: true })
      copyFileSync('src/ui/styles.css', 'dist/style.css')
    },
  }
}
