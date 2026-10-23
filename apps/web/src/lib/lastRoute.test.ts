import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

describe("last route", () => {
  beforeEach(() => {
    vi.resetModules();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  it("reopens the thread or the personal agent once per start", async () => {
    const { rememberRoute, takeRouteToRestore } = await import("./lastRoute");
    rememberRoute("/env-1/thread-1");
    rememberRoute("/personal");
    expect(takeRouteToRestore()).toBe("/personal");
    // Later visits to the start page open a new draft as before.
    expect(takeRouteToRestore()).toBeNull();
  });

  it("does not remember drafts, settings or other pages", async () => {
    const { rememberRoute, takeRouteToRestore } = await import("./lastRoute");
    rememberRoute("/env-1/thread-1");
    for (const path of ["/draft/abc", "/settings/general", "/new", "/", "/pull-requests"]) {
      rememberRoute(path);
    }
    expect(takeRouteToRestore()).toBe("/env-1/thread-1");
  });
});
