import { IndexScreen } from "./index-screen";
import { SessionScreen } from "./session-screen";
import { SettingsScreen } from "./settings-screen";
import { usePath } from "./router";

export function App() {
  const path = usePath();
  const match = /^\/s\/([^/]+)$/.exec(path);
  if (match) return <SessionScreen id={match[1] ?? ""} />;
  if (path === "/settings") return <SettingsScreen />;
  return <IndexScreen />;
}
