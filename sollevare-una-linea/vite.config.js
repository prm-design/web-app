import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/web-app/sollevare-una-linea/",
  plugins: [react(), tailwindcss()],
});

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
