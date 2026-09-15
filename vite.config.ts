import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Every runtime asset lives in `public/`, which Vite serves as-is at the web
  // root: `public/models/scene.glb` is fetched from `/models/scene.glb`, and a
  // sound dropped in `public/sounds/` is fetched from `/sounds/<name>`.
  server: { port: 5173, open: true, host: true },
  build: {
    target: "es2022",
    // Babylon is a big single dependency; the default warning threshold is noise.
    chunkSizeWarningLimit: 6000,
  },
});
