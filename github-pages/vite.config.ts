import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // relative assets — works at any Pages subpath
  build: { outDir: 'dist' },
});
