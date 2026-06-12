import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Invoked as `vite build ui` from the repo root: the positional root makes
// Vite pick this config up and resolve paths against ui/. The bundle lands in
// dist/ui next to the tsc output, so the published `files: ["dist"]` ships it
// (DECISIONS.md "UI toolchain: Vite build into dist/, React as devDependency").
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
});
