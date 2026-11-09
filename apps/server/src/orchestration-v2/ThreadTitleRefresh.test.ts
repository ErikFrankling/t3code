import { describe, expect, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  isTitleRefreshRun,
  looksLikeSeedTitle,
  titleRefreshAllowed,
  type TitleRefreshThread,
} from "./ThreadTitleRefresh.ts";

const rootThreadId = ThreadId.make("thread-1");
const thread = (overrides: Partial<TitleRefreshThread> = {}): TitleRefreshThread => ({
  title: "Session title renaming",
  titleSource: "generated",
  titleRegeneration: null,
  archivedAt: null,
  deletedAt: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId },
  createdBy: "user",
  creationSource: "web",
  ...overrides,
});

const dictation =
  "Kinda really dislike the selecting UI right now in T3 Code. It's like selecting sessions.";

describe("ThreadTitleRefresh", () => {
  it("refreshes after the first three runs, then every third run", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9, 10, 12].filter(isTitleRefreshRun)).toEqual([1, 2, 3, 6, 9, 12]);
    expect(isTitleRefreshRun(0)).toBe(false);
  });

  it("recognizes a title cut from the first message", () => {
    expect(
      looksLikeSeedTitle("Kinda really dislike the selecting UI right now in...", dictation),
    ).toBe(true);
    expect(
      looksLikeSeedTitle("Kinda really dislike the selecting UI right now in…", dictation),
    ).toBe(true);
    expect(looksLikeSeedTitle("New thread", undefined)).toBe(true);
    expect(looksLikeSeedTitle("Sidebar session titles", dictation)).toBe(false);
    expect(looksLikeSeedTitle("Kinda", dictation)).toBe(false);
    expect(looksLikeSeedTitle("Personal agent", undefined)).toBe(false);
    // A dictation seed comes from the live draft, not the cleaned-up message that was delivered.
    expect(
      looksLikeSeedTitle(
        "Okay, I have a new laptop set up and two setup. It...",
        "Okay. I have a new laptop set up. To set up. It's a Samsung laptop.",
      ),
    ).toBe(true);
    expect(looksLikeSeedTitle("Waiting for the build...", undefined)).toBe(false);
  });

  it("follows the conversation for seeded and generated titles", () => {
    expect(titleRefreshAllowed(thread({ titleSource: "seed" }), () => undefined)).toBe(true);
    expect(titleRefreshAllowed(thread({ titleSource: "generated" }), () => undefined)).toBe(true);
  });

  it("keeps explicit renames and titles the server gives at creation", () => {
    expect(titleRefreshAllowed(thread({ titleSource: "manual" }), () => undefined)).toBe(false);
    expect(
      titleRefreshAllowed(
        thread({ titleSource: undefined, title: "Personal agent", createdBy: "system" }),
        () => dictation,
      ),
    ).toBe(false);
    expect(
      titleRefreshAllowed(
        thread({ titleSource: "manual", createdBy: "agent", creationSource: "mcp" }),
        () => undefined,
      ),
    ).toBe(false);
  });

  it("follows the conversation for a title an agent picked when it launched the thread", () => {
    expect(
      titleRefreshAllowed(
        thread({
          titleSource: undefined,
          title: "Homelab heavy worker unusable: load 150-210, heavy status hangs",
          createdBy: "agent",
          creationSource: "mcp",
        }),
        () => undefined,
      ),
    ).toBe(true);
  });

  it("refreshes an untracked title that is still the start of the first message", () => {
    expect(
      titleRefreshAllowed(
        thread({
          titleSource: undefined,
          title: "Kinda really dislike the selecting UI right now in...",
        }),
        () => dictation,
      ),
    ).toBe(true);
  });

  it("leaves archived, deleted, subagent and in-flight threads alone", () => {
    expect(
      titleRefreshAllowed(thread({ archivedAt: DateTime.makeUnsafe(0) }), () => undefined),
    ).toBe(false);
    expect(
      titleRefreshAllowed(thread({ deletedAt: DateTime.makeUnsafe(0) }), () => undefined),
    ).toBe(false);
    expect(
      titleRefreshAllowed(
        thread({
          lineage: {
            parentThreadId: rootThreadId,
            relationshipToParent: "subagent",
            rootThreadId,
          },
        }),
        () => undefined,
      ),
    ).toBe(false);
    expect(
      titleRefreshAllowed(
        thread({
          titleRegeneration: {
            requestId: CommandId.make("request-1"),
            startedAt: DateTime.makeUnsafe(0),
          },
        }),
        () => undefined,
      ),
    ).toBe(false);
  });
});
