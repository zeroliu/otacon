import { SessionScreen } from "./session-screen";
import { SettingsScreen } from "./settings-screen";
import { AppShell } from "./shell";
import { Welcome } from "./welcome";
import { navigate, usePath } from "./router";
import { KnowledgeScreen } from "./pr-review/knowledge-screen";

export function App() {
  const path = usePath();
  const match = /^\/s\/([^/]+)$/.exec(path);
  // Resolve the route to a content screen, then wrap it in the persistent shell
  // (sidebar + content track) — the chrome is the same on every route, so it
  // lives outside the switch (app shell).
  const screen = match ? (
    <SessionScreen id={match[1] ?? ""} />
  ) : path === "/settings" ? (
    <SettingsScreen />
  ) : path === "/knowledge" ? (
    <KnowledgeScreen onBack={() => navigate("/")} backLabel="← sessions" />
  ) : (
    <Welcome />
  );
  return <AppShell>{screen}</AppShell>;
}
