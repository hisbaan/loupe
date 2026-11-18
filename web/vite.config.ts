import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const api = process.env.LOUPE_API_URL ?? "http://localhost:3000"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    // The API sets cookies for, and redirects to, LOUPE_PUBLIC_URL, which in dev
    // is this server. Proxy keeps everything same-origin.
    proxy: {
      "/api": api,
      "/auth": api,
    },
  },
})
