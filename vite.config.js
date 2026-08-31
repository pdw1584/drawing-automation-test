import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        compare: resolve(import.meta.dirname, "index.html"),
        review: resolve(import.meta.dirname, "pages/review.html"),
        convert: resolve(import.meta.dirname, "pages/convert.html"),
        renderTest: resolve(import.meta.dirname, "pages/render-test.html"),
        cadFrame: resolve(import.meta.dirname, "pages/cad-frame.html")
      }
    }
  }
});
