import { defineConfig } from "vite";

// Builds the Service Worker as a single, unhashed file at the web root
// (dist/public/sw.js) so it registers with scope "/" and can intercept
// /vs/<peerId>/* across the whole origin. Run after the main `vite build`
// so it doesn't wipe the app assets (emptyOutDir: false).
export default defineConfig({
  build: {
    outDir: "dist/public",
    emptyOutDir: false,
    lib: {
      entry: "src/web/sw.ts",
      formats: ["es"],
      fileName: () => "sw.js",
    },
    rollupOptions: {
      output: { entryFileNames: "sw.js" },
    },
  },
});
