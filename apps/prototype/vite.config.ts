import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained HTML file, so the prototype can be shared as a single page.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: { target: 'es2022', assetsInlineLimit: 100_000_000, cssCodeSplit: false },
});
