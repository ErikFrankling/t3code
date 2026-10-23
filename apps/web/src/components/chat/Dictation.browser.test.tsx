import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { EnvironmentId } from "@t3tools/contracts";

// The app's theme, so the full-screen view is checked in light and dark.
import "~/index.css";

import { act, render, stubGlobal } from "../../../test/render";
import { Dictation } from "./Dictation";
import { indexedDbDictationStorage, type DictationRecord } from "./dictationStorage";

const paused: DictationRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  serverId: "11111111-1111-4111-8111-111111111111",
  target: "chat-delete-test",
  environmentId: "env",
  project: "/repo",
  threadId: null,
  createdAt: 1,
  state: "paused",
  sizes: [32000 * 90],
  uploaded: 0,
  registered: false,
  handedOff: false,
  server: null,
  notice: "",
};

const button = (name: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label")?.startsWith(name),
  );
  if (!found) {
    const labels = [...document.querySelectorAll("button")].map(
      (element) => element.getAttribute("aria-label") ?? element.textContent?.trim(),
    );
    throw new Error(`No button ${name} (buttons: ${labels.join(" | ")})`);
  }
  return found;
};

/** Relative luminance (0 black … 1 white) of a computed CSS colour. */
function luminance(color: string): number {
  const canvas = document.createElement("canvas").getContext("2d")!;
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b] = [...canvas.getImageData(0, 0, 1, 1).data].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The nearest element with a painted (non-transparent) background, from `start` up. */
function paintedBackground(start: Element): string {
  for (let node: Element | null = start; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/** The open full-screen view follows the app's light and dark theme, at phone width. */
async function checkThemes() {
  await page.viewport(390, 844);
  for (const appearance of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", appearance === "dark");
    // The full-screen view's own background, not a button's.
    const view = document.querySelector('[data-testid="dictation-view"]');
    expect(view).not.toBeNull();
    const background = luminance(paintedBackground(view!));
    if (appearance === "dark") expect(background).toBeLessThan(0.2);
    else expect(background).toBeGreaterThan(0.6);
    await page.screenshot({ path: `__screenshots__/dictation-full-screen-${appearance}.png` });
  }
  document.documentElement.classList.remove("dark");
}

describe("Dictation", () => {
  it("deletes a recording kept on the device only after confirmation", async () => {
    // The speech service is down for the whole test.
    using _fetch = stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    const storage = indexedDbDictationStorage();
    await storage.putChunk(paused, 0, new Int16Array(16000 * 90));
    await using _screen = await render(
      <Dictation
        environmentId={"env" as EnvironmentId}
        target={paused.target}
        project="/repo"
        threadId={null}
        onSend={async () => undefined}
        onInsert={() => true}
        onBusyChange={() => undefined}
      />,
      { router: false },
    );
    await vi.waitFor(() => button("1 paused recording"));
    await act(async () => button("1 paused recording").click());
    await vi.waitFor(() => button("Resume"));
    await checkThemes();

    await act(async () => button("Delete").click());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("2 min of audio will be gone."),
    );
    await act(async () => button("Keep it").click());
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Delete this recording?"),
    );
    expect(await storage.getRecord(paused.id)).toBeDefined();

    await act(async () => button("Delete").click());
    await vi.waitFor(() => button("Delete recording"));
    await act(async () => button("Delete recording").click());
    await vi.waitFor(async () => expect(await storage.getRecord(paused.id)).toBeUndefined());
    expect(await storage.getChunk(paused.id, 0)).toBeUndefined();
  });
});
