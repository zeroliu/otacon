/// <reference types="vite/client" />

// The build version Vite bakes in via `define` (vite.config.ts). self-heal.ts
// compares it against the daemon version learned over SSE to decide whether a
// tab is running a stale bundle (DESIGN.md §16).
declare const __OTACON_VERSION__: string;
