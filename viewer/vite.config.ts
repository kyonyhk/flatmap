import { defineConfig } from "vite";

export default defineConfig({
  // Top-level await in main.ts; every browser that runs deck.gl 9 supports it.
  build: { target: "es2022" },
});
