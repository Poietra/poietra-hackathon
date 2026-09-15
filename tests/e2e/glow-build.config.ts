import { defineConfig } from 'vite';
const original = "import { createFramePainter } from './painter';";
export default defineConfig({
  plugins: [{ name: 'measure-export-painter', enforce: 'pre', transform(source, id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/engine/export.ts')) return;
    if (!source.includes(original)) throw new Error('Exporter painter import changed; update the measurement wrapper.');
    return source.replace(original, "import { createFramePainter } from '/tests/e2e/fixtures/glow-painter';");
  } }],
  build: { target: 'es2022', outDir: 'test-results/glow-initialization-build', rollupOptions: { input: ['tests/e2e/fixtures/glow-initialization.html', 'tests/e2e/fixtures/glow-buffer.html'] } },
});
