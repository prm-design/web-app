import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

base: "/web-app/sollevare-una-linea/",


export default defineConfig({
  plugins: [react(), tailwindcss()],
});
