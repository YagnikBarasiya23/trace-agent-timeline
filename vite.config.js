import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /trace-agent-timeline/.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
