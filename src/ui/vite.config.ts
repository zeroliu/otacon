import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VERSION } from "../shared/version.js";

// Invoked as `vite build src/ui` from the repo root: the positional root makes
// Vite pick this config up and resolve paths against src/ui/. The bundle lands in
// dist/ui next to the tsc output, so the published `files: ["dist"]` ships it
// (DECISIONS.md "UI toolchain: Vite build into dist/, React as devDependency").
export default defineConfig({
  plugins: [react()],
  // Bake the build's version into the bundle so a tab can compare it against the
  // daemon version it learns over SSE and self-heal on a mismatch (self-heal.ts,
  // DESIGN.md §16). Same VERSION the daemon's snapshot carries.
  define: { __OTACON_VERSION__: JSON.stringify(VERSION) },
  // mermaid is one intentionally huge lazy chunk (fetched on the first
  // diagram, never by the index) — don't warn about its size.
  build: { outDir: "../../dist/ui", emptyOutDir: true, chunkSizeWarningLimit: 1800 },
});
