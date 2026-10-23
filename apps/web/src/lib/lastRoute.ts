/**
 * Where the desktop app was, so it opens there again: a restart (a deploy
 * relaunches it) used to land on a new draft instead of the thread Erik was in
 * (he lives in the personal agent).
 */
const KEY = "t3code:last-route";

/** Pages worth coming back to: a thread, or the personal agent. */
export function isRestorableRoute(pathname: string): boolean {
  if (pathname === "/personal") return true;
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 2 &&
    !["draft", "settings", "projects", "pull-requests"].includes(parts[0]!) &&
    parts[0] !== "new"
  );
}

export function rememberRoute(pathname: string): void {
  if (!isRestorableRoute(pathname)) return;
  try {
    localStorage.setItem(KEY, pathname);
  } catch {
    // Not remembered; the next start opens a new draft as before.
  }
}

let restored = false;

/** The route to open instead of a new draft, once per start of the app. */
export function takeRouteToRestore(): string | null {
  if (restored) return null;
  restored = true;
  try {
    const saved = localStorage.getItem(KEY);
    return saved && isRestorableRoute(saved) ? saved : null;
  } catch {
    return null;
  }
}
