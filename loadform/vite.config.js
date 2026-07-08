import { defineConfig } from 'vite';

export default defineConfig({
  // Vite looks for index.html in this directory
  root: 'src',
  // Tauri expects a fixed port for dev server
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell Vite to watch the Rust source files for changes too
      ignored: ['**/src-tauri/**'],
    },
  },
  // Prevent Vite from clearing the screen when running in Tauri CLI
  clearScreen: false,
  // Ensure assets are referenced correctly in production builds
  build: {
    // Output to ../dist (relative to src/) so Tauri finds it at loadform/dist/
    outDir: '../dist',
    emptyOutDir: true,
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // Don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
