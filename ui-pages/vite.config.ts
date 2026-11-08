import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

/** One HTML entry per page, so a page loads only its own code (spec 5.4: lazy, light WebUI). */
const PAGES = ["newtab", "settings", "memory", "routines", "import", "welcome", "command-bar"];

export default defineConfig({
  plugins: [preact()],
  base: "./",
  build: {
    target: "chrome130",
    cssCodeSplit: true,
    rollupOptions: { input: Object.fromEntries(PAGES.map((p) => [p, resolve(__dirname, `${p}.html`)])) },
  },
});
