import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies /api requests to the backend during development so the frontend
// can just call fetch("/api/...") without worrying about CORS or hardcoding
// a host. In production, point this at your deployed API instead (or keep
// using the VITE_API_URL env var approach in src/api.js).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
