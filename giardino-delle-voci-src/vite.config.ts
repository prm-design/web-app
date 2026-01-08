import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/web-app/giardino-delle-voci/",
  plugins: [react(), tailwindcss()],
});