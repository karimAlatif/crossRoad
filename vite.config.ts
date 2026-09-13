import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The existing `assets/` folder is served as-is at the web root, so
  // `assets/scene.glb` is fetched at runtime from `/scene.glb`. Nothing is
  // copied or duplicated: drop new files in `assets/` and they are served.
  publicDir: "assets",
  server: { port: 5173, open: true },
  build: {
    target: "es2022",
    // Babylon is a big single dependency; the default warning threshold is noise.
    chunkSizeWarningLimit: 6000,
  },
});
