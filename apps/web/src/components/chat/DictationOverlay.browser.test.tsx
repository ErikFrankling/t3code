import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { EnvironmentId } from "@t3tools/contracts";

// The app's theme, so the card is checked in light and dark.
import "~/index.css";

import { act, render, stubGlobal } from "../../../test/render";
import { Dictation } from "./Dictation";
import { indexedDbDictationStorage, type DictationRecord } from "./dictationStorage";

const paused: DictationRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  serverId: "22222222-2222-4222-8222-222222222222",
  target: "chat-overlay-test",
  environmentId: "env",
  project: "/repo",
  threadId: null,
  createdAt: 1,
  state: "paused",
  sizes: [32000 * 40],
  uploaded: 40,
  registered: true,
  handedOff: false,
  server: {
    status: "recording",
    draft:
      "okay so looking at the screenshot the header overlaps the sidebar and I think we should move the filter into the toolbar",
    final: "Okay, so looking at the screenshot, the header overlaps the sidebar,",
    error: "",
  },
  notice: "",
};

/** A screenshot in the chat, like the one Erik looks at while he talks. */
const SCREENSHOT = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#3b82f6"/><rect x="0" y="0" width="640" height="56" fill="#1e3a8a"/><rect x="0" y="56" width="150" height="304" fill="#1e40af"/><text x="180" y="200" font-size="34" fill="white" font-family="sans-serif">Settings page screenshot</text></svg>`,
)}`;

const button = (name: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label")?.startsWith(name),
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
};

function Chat() {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div
        data-testid="chat"
        className="messages-timeline-scroll min-h-0 flex-1 overflow-y-auto px-4 py-6"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {Array.from({ length: 6 }, (_, index) => (
            <p key={index} className="text-sm leading-relaxed">
              Agent: Here is round {index + 1} of the layout review. The toolbar now groups the
              filters, the sidebar collapses below 900 px, and the header keeps its height when the
              window narrows.
            </p>
          ))}
          <p className="text-sm">You: what does it look like now?</p>
          <img
            data-testid="chat-image"
            src={SCREENSHOT}
            alt="Screenshot"
            className="w-full max-w-md rounded-lg border"
          />
          <p data-testid="last-reply" className="text-sm leading-relaxed">
            Agent: This is the current settings page. The header still overlaps the sidebar at
            narrow widths; tell me where the filter should go.
          </p>
        </div>
      </div>
      <div data-chat-composer-stack="true" className="mx-auto mb-3 w-full max-w-3xl">
        <div data-dictation-slot="true" />
        <form
          data-chat-composer-form="true"
          onSubmit={(event) => event.preventDefault()}
          className="rounded-2xl border bg-card p-3"
        >
          <div className="flex items-center gap-2">
            <span className="flex-1 text-muted-foreground text-sm">Ask anything…</span>
            <Dictation
              environmentId={"env" as EnvironmentId}
              target={paused.target}
              project="/repo"
              threadId={null}
              onSend={async () => undefined}
              onInsert={() => true}
              onBusyChange={() => undefined}
            />
          </div>
        </form>
      </div>
    </div>
  );
}

const card = () => document.querySelector<HTMLElement>('[data-testid="dictation-view"]');

describe("Dictation overlay", () => {
  it("opens as a card over the chat, which stays visible and clickable, with full screen one click away", async () => {
    using _fetch = stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    localStorage.removeItem("t3code:dictation-full-screen");
    await indexedDbDictationStorage().putChunk(paused, 0, new Int16Array(16000 * 40));
    await using _screen = await render(<Chat />, { router: false });
    await vi.waitFor(() => button("1 paused recording"));
    // At the end of the chat when dictation opens: it stays at the end while the card makes room.
    const timeline = document.querySelector<HTMLElement>('[data-testid="chat"]')!;
    timeline.scrollTop = timeline.scrollHeight;
    await act(async () => button("1 paused recording").click());
    await vi.waitFor(() => expect(card()?.dataset.size).toBe("compact"));
    await vi.waitFor(() =>
      expect(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight).toBeLessThan(2),
    );

    for (const [width, height, name] of [
      [1280, 800, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await page.viewport(width, height);
      const chat = document.querySelector<HTMLElement>('[data-testid="chat"]')!;
      chat.scrollTop = chat.scrollHeight;
      await vi.waitFor(() => {
        const box = card()!.getBoundingClientRect();
        const form = document.querySelector("form")!.getBoundingClientRect();
        // Right above the message box, at its width, and never more than about half the window.
        expect(Math.abs(box.bottom - (form.top - 8))).toBeLessThan(2);
        expect(Math.abs(box.width - form.width)).toBeLessThan(2);
        expect(box.height).toBeLessThan(height * 0.6);
      });
      // The chat makes room: scrolled to the end, the last reply is fully above the card.
      chat.scrollTop = chat.scrollHeight;
      const reply = document.querySelector('[data-testid="last-reply"]')!.getBoundingClientRect();
      expect(reply.bottom).toBeLessThanOrEqual(card()!.getBoundingClientRect().top);
      // The chat behind it stays clickable: the top of the chat is the chat, not a backdrop.
      const top = document.elementFromPoint(width / 2, 40);
      expect(chat.contains(top)).toBe(true);
      chat.scrollTop = 0;
      expect(chat.scrollTop).toBe(0);
      chat.scrollTop = chat.scrollHeight;
      for (const appearance of ["dark", "light"] as const) {
        document.documentElement.classList.toggle("dark", appearance === "dark");
        await page.screenshot({
          path: `__screenshots__/dictation-overlay-${name}-${appearance}.png`,
        });
      }
    }
    document.documentElement.classList.remove("dark");

    await act(async () => button("Full screen").click());
    await vi.waitFor(() => expect(card()?.dataset.size).toBe("full"));
    expect(localStorage.getItem("t3code:dictation-full-screen")).toBe("1");
    await page.viewport(1280, 800);
    await page.screenshot({ path: "__screenshots__/dictation-overlay-full-screen.png" });
    await act(async () => button("Make it small again").click());
    await vi.waitFor(() => expect(card()?.dataset.size).toBe("compact"));
  });
});
