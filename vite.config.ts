import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'sqlite-reader.mjs' : 'sqlite-reader.cjs'),
    },
    target: 'esnext',
    minify: false,
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
})
