import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { EnvironmentId } from "@t3tools/contracts";

import "~/index.css";

import { act, render, stubGlobal } from "../../../test/render";
import { ReadAloudDock, readAloudPlayer, useReadAloud } from "./ReadAloud";

/** A tenth of a second of silence as a WAV, base64: a clip the browser can really play. */
function silentWav(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return btoa(String.fromCharCode(...bytes));
}

const SENTENCES = [
  "The settings page still has the header overlapping the sidebar at narrow widths.",
  "I moved the filter into the toolbar, as you asked, and the sidebar now collapses below nine hundred pixels.",
  "Tell me if the toolbar should also hold the search box.",
];

const SCREENSHOT = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#3b82f6"/><rect width="640" height="56" fill="#1e3a8a"/><rect y="56" width="150" height="304" fill="#1e40af"/><text x="180" y="200" font-size="34" fill="white" font-family="sans-serif">Settings page screenshot</text></svg>`,
)}`;

function Phase() {
  return <span data-testid="phase">{useReadAloud().phase}</span>;
}

function Chat() {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div data-testid="chat" className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {Array.from({ length: 5 }, (_, index) => (
            <p key={index} className="text-sm leading-relaxed">
              Agent: Round {index + 1}: the toolbar groups the filters and the header keeps its
              height when the window narrows.
            </p>
          ))}
          <img src={SCREENSHOT} alt="Screenshot" className="w-full max-w-md rounded-lg border" />
          <p data-testid="last-reply" className="text-sm leading-relaxed">
            Agent: {SENTENCES.join(" ")}
          </p>
        </div>
      </div>
      <div data-chat-composer-stack="true" className="relative mx-auto mb-3 w-full max-w-3xl">
        <ReadAloudDock
          environmentId={"env" as EnvironmentId}
          latest={{ id: "reply-1", text: SENTENCES.join(" ") }}
        />
        <div data-dictation-slot="true" />
        <form
          data-chat-composer-form="true"
          onSubmit={(event) => event.preventDefault()}
          className="rounded-2xl border bg-card p-3"
        >
          <span className="text-muted-foreground text-sm">Ask anything…</span>
          <Phase />
        </form>
      </div>
    </div>
  );
}

const panel = () => document.querySelector<HTMLElement>('[aria-label="Read aloud"]');

describe("Read aloud panel", () => {
  it("shows the text being read above the composer, in the flow, and keeps it after the reading ends", async () => {
    const wav = silentWav();
    using _fetch = stubGlobal("fetch", async () =>
      Response.json({
        id: "job-1",
        status: "complete",
        voice: "small",
        error: "",
        sentences: SENTENCES.map((text) => ({ text, ready: true, audio: wav, span: 1 })),
      }),
    );
    await using _screen = await render(<Chat />, { router: false });
    const read = [...document.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === "Read the latest reply aloud",
    )!;
    await act(async () => read.click());
    await vi.waitFor(() => expect(panel()?.textContent).toContain("search box"));

    // Played to the end (or stopped by the browser's autoplay rules): the text stays.
    await vi.waitFor(
      () =>
        expect(["done", "playing", "error"]).toContain(
          document.querySelector('[data-testid="phase"]')?.textContent,
        ),
      { timeout: 5000 },
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(panel()).not.toBeNull();

    for (const [width, height, name] of [
      [1280, 800, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await page.viewport(width, height);
      const chat = document.querySelector<HTMLElement>('[data-testid="chat"]')!;
      chat.scrollTop = chat.scrollHeight;
      await vi.waitFor(() => {
        // In the flow: the chat makes room, so its last message is fully above the panel.
        const reply = document.querySelector('[data-testid="last-reply"]')!.getBoundingClientRect();
        expect(reply.bottom).toBeLessThanOrEqual(panel()!.getBoundingClientRect().top + 1);
      });
      for (const appearance of ["dark", "light"] as const) {
        document.documentElement.classList.toggle("dark", appearance === "dark");
        await page.screenshot({
          path: `__screenshots__/read-aloud-panel-${name}-${appearance}.png`,
        });
      }
    }
    document.documentElement.classList.remove("dark");
    readAloudPlayer.stop();
    await vi.waitFor(() => expect(panel()).toBeNull());
  });
});
