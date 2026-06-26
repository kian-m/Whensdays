import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy /api to the Go service so the browser sees a single origin
// (no CORS, same-origin cookies). The API base URL is never hardcoded in the app.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    proxy: {
      "/api": {
        target: process.env.API_URL || "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
