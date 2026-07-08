import { defineConfig } from 'vite';

export default defineConfig({
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
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // Don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
