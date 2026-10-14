// Builds the clickable reference site. Uses the REAL UI source in ../src, with every Tauri call
// swapped for the fakes in ./mocks. Nothing here touches the real app.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The real app's source still says "Clickr" in places; the reference shows the new name "Clickr AI".
// This swaps the text while building the reference only. The real app's files are not changed.
const newName = {
  name: "reference-rename",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!/\/src\/[^/]+\.tsx?$/.test(id)) return null;
    return code.replace(/\bClickr\b(?! AI)/g, "Clickr AI");
  },
};

const here = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  root: here(".."),
  base: "./",
  plugins: [newName, react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: here("mocks/core.ts") },
      { find: "@tauri-apps/api/event", replacement: here("mocks/event.ts") },
      { find: "@tauri-apps/api/window", replacement: here("mocks/window.ts") },
      { find: "@tauri-apps/api/dpi", replacement: here("mocks/window.ts") },
      { find: "@tauri-apps/api/webview", replacement: here("mocks/webview.ts") },
      { find: "@tauri-apps/api/app", replacement: here("mocks/app.ts") },
      { find: "@tauri-apps/plugin-updater", replacement: here("mocks/plugins.ts") },
      { find: "@tauri-apps/plugin-autostart", replacement: here("mocks/plugins.ts") },
      { find: "@tauri-apps/plugin-notification", replacement: here("mocks/plugins.ts") },
      { find: "@tauri-apps/plugin-opener", replacement: here("mocks/plugins.ts") },
    ],
  },
  server: { port: 4173, strictPort: true, open: "/design-reference/index.html" },
  build: {
    outDir: here("site"),
    emptyOutDir: true,
    rollupOptions: { input: { index: here("index.html"), app: here("app.html") } },
  },
});
