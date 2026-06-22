import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SessionsProvider } from "./api";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("otacon: #root missing from the shell");
createRoot(root).render(
  <StrictMode>
    {/* One index SSE stream for the whole tree — every useSessions() reads it. */}
    <SessionsProvider>
      <App />
    </SessionsProvider>
  </StrictMode>,
);
