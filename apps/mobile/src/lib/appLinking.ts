import type { NavigationState, PartialState } from "@react-navigation/native";

/**
 * The Expo dev client launches the app via
 * <scheme>://expo-development-client/?url=<packager> — that URL addresses
 * the launcher, not app navigation. Without this filter it falls through
 * to the NotFound wildcard route on every dev launch.
 */
export function shouldHandleAppLink(url: string): boolean {
  return (
    !url.includes("expo-development-client") &&
    !url.includes("://expo-sharing") &&
    !/^t3code(-dev|-preview)?:\/*$/.test(url)
  );
}

/** Keep the published draft URLs while using the root thread screen. */
export function restoreDraftLinkState(
  state: PartialState<NavigationState> | undefined,
  path: string,
) {
  const pathname = path.split("?")[0]?.replace(/^\/+|\/+$/g, "");
  if (!state || !pathname || !/^new\/draft(?:\/|$)/.test(pathname)) return state;
  const target = state.routes.at(-1);
  if (!target) return state;
  const draft = target.params ?? {};
  const routes = state.routes.slice(0, -1);
  routes.push({ name: "Thread", params: { draft } });
  if (pathname !== "new/draft") routes.push(target);
  return { ...state, index: routes.length - 1, routes };
}

/**
 * `threads/<environment>/<thread>/dictate` (a tapped "answer by voice"
 * notification) opens the thread with `intent=dictate`, which starts
 * dictation in its composer. The native notification code only passes plain
 * paths, so the intent travels as a path segment.
 */
export function rewriteDictateLink(path: string): string {
  const [pathname = "", search] = path.split("?", 2);
  const match = /^(\/*threads\/[^/]+\/[^/]+)\/dictate\/?$/.exec(pathname);
  if (!match) return path;
  const query = new URLSearchParams(search);
  query.set("intent", "dictate");
  return `${match[1]}?${query.toString()}`;
}
