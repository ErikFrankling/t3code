import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { PersonalAgentHome } from "./PersonalAgentHome";

const homeState = {
  items: [],
  spoken: [
    {
      id: "spoken-1",
      text: "Lecture four in ten minutes",
      source: null,
      queuedAt: "2026-11-04T08:49:00.000Z",
      status: "spoken",
      statusAt: "2026-11-04T08:49:05.000Z",
      reason: null,
      sink: null,
      audioPath: null,
    },
  ],
  today: null,
};

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: homeState, error: null }),
}));
vi.mock("./SpeakModeToggle", () => ({ SpeakModeToggle: () => null }));
vi.mock("./TodoList", () => ({ TodoList: () => <p>todo list body</p> }));

const PANELS_KEY = "t3.personalAgent.panels";

async function renderHome() {
  return render(
    <PersonalAgentHome
      environmentId={EnvironmentId.make("local")}
      working={false}
      chat={<main>chat body</main>}
    />,
    { router: false },
  );
}

/**
 * The widest layout (2xl), where the to-do panel sits left of the chat and Said
 * aloud right of it, with no remembered panel state; both restored on dispose.
 */
async function wideHome() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  window.localStorage.removeItem(PANELS_KEY);
  await page.viewport(1700, 900);
  return {
    [Symbol.asyncDispose]: async () => {
      window.localStorage.removeItem(PANELS_KEY);
      await page.viewport(viewport.width, viewport.height);
    },
  };
}

describe("PersonalAgentHome side panels", () => {
  it("closes and reopens the to-do and Said aloud panels", async () => {
    await using _wide = await wideHome();
    await using screen = await renderHome();
    const todo = screen.getByRole("complementary", { name: "Personal agent", includeHidden: true });
    const said = screen.getByRole("complementary", { name: "Said aloud", includeHidden: true });
    await expect.element(todo).toBeVisible();
    await expect.element(said).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Hide the to-do panel" }));
    await expect.element(todo).not.toBeVisible();
    await expect.element(screen.getByText("chat body")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Hide Said aloud" }));
    await expect.element(said).not.toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Show the to-do panel" }));
    await expect.element(todo).toBeVisible();
    // With Said aloud closed, its feed is still one tab away in the to-do panel.
    await expect
      .element(screen.getByRole("tab", { name: /Said aloud/, includeHidden: true }))
      .toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Show Said aloud" }));
    await expect.element(said).toBeVisible();
    await expect
      .element(screen.getByRole("tab", { name: /Said aloud/, includeHidden: true }))
      .not.toBeVisible();
  });

  it("keeps the chat's window-edge panel controls off Said aloud and its rail", async () => {
    await using _wide = await wideHome();
    await using screen = await renderHome();
    const chat = screen.getByText("chat body").element().parentElement;
    if (chat === null) throw new Error("chat column missing");
    // Controls fixed at `right: var(--workspace-controls-right)` must clear the
    // 20rem panel (320px), or the 2.5rem rail (40px) when the panel is closed.
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;right:var(--workspace-controls-right)";
    chat.append(probe);
    const offset = () => Number.parseFloat(getComputedStyle(probe).right);
    expect(offset()).toBeGreaterThanOrEqual(320);

    await userEvent.click(screen.getByRole("button", { name: "Hide Said aloud" }));
    await expect.poll(offset).toBeGreaterThanOrEqual(40);
    expect(offset()).toBeLessThan(320);
    probe.remove();
  });

  it("remembers a closed panel across reloads", async () => {
    await using _wide = await wideHome();
    {
      await using screen = await renderHome();
      await userEvent.click(screen.getByRole("button", { name: "Hide Said aloud" }));
      await expect
        .element(screen.getByRole("complementary", { name: "Said aloud", includeHidden: true }))
        .not.toBeVisible();
    }
    expect(JSON.parse(window.localStorage.getItem(PANELS_KEY) ?? "null")).toEqual({
      todo: true,
      spoken: false,
    });

    await using screen = await renderHome();
    await expect
      .element(screen.getByRole("complementary", { name: "Said aloud", includeHidden: true }))
      .not.toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Show Said aloud" })).toBeVisible();
    await expect
      .element(screen.getByRole("complementary", { name: "Personal agent", includeHidden: true }))
      .toBeVisible();
  });
});
