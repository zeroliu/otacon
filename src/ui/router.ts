// Hand-rolled history routing: two screens don't justify a router dependency.

import { useEffect, useState } from "react";

export function navigate(to: string): void {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * onClick for an in-app `<a href>`: intercept a plain left-click for client
 * routing while leaving modifier/middle-clicks to the browser (new tab/window).
 * Pair with a real `href` so the link stays copyable and keyboard-accessible.
 */
export function linkClick(to: string): (event: import("react").MouseEvent) => void {
  return (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
}

export function usePath(): string {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return path;
}
