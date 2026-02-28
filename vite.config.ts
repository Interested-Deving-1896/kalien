import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [tailwindcss(), react(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    watch: {
      ignored: [
        "**/autopilot/**",
        "**/cli/**",
        "**/kalien-contract/**",
        "**/kalien-verifier/**",
        "**/scripts/**",
        "**/batch-results/**",
        "**/generated-tapes/**",
        "**/test-fixtures/**",
        "**/tests/**",
        "**/docs/**",
        "**/dist/**",
      ],
    },
  },
});
