import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Invoked as `vite build src/ui` from the repo root: the positional root makes
// Vite pick this config up and resolve paths against src/ui/. The bundle lands in
// dist/ui next to the tsc output, so the published `files: ["dist"]` ships it
// (DECISIONS.md "UI toolchain: Vite build into dist/, React as devDependency").
export default defineConfig({
  plugins: [react()],
  // mermaid is one intentionally huge lazy chunk (fetched on the first
  // diagram, never by the index) — don't warn about its size.
  build: { outDir: "../../dist/ui", emptyOutDir: true, chunkSizeWarningLimit: 1800 },
});
