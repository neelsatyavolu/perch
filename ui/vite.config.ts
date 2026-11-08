import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Two pages, each a small shell that loads its page code lazily. Relative asset paths, so the
 * same build works from a WebUI resource bundle (chrome://perch-chat/) and from /ui/ in development.
 */
export default defineConfig({
  base: "./",
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    target: "es2023",
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        sidebar: resolve(import.meta.dirname, "sidebar.html"),
        chat: resolve(import.meta.dirname, "chat.html"),
        // The trusted shells that frame the two pages inside Perch (src/host/shell.ts).
        "shell-chat": resolve(import.meta.dirname, "shell-chat.html"),
        "shell-side": resolve(import.meta.dirname, "shell-side.html"),
      },
    },
  },
});
