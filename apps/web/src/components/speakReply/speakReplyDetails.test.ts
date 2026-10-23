import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { speakReplyDetailsMessage, speakReplyLinkTarget } from "./speakReplyDetails";

const at = (ms: number) => DateTime.makeUnsafe(ms);

function item(
  type: "assistant_message" | "user_message",
  text: string,
  startedAt: number,
): OrchestrationV2ProjectedTurnItem {
  return {
    position: startedAt,
    visibility: "local",
    item: {
      type,
      text,
      messageId: `m-${startedAt}`,
      startedAt: at(startedAt),
      updatedAt: at(startedAt),
    },
  } as unknown as OrchestrationV2ProjectedTurnItem;
}

describe("speakReplyDetailsMessage", () => {
  it("picks the latest assistant message that existed when the line was queued", () => {
    const items = [
      item("assistant_message", "older", 1_000),
      item("user_message", "question", 2_000),
      item("assistant_message", "the details", 3_000),
      item("assistant_message", "written after speaking", 5_000),
    ];
    expect(speakReplyDetailsMessage(items, 4_000)?.text).toBe("the details");
    expect(speakReplyDetailsMessage(items, 3_000)?.text).toBe("the details");
    expect(speakReplyDetailsMessage(items, 500)).toBeNull();
  });

  it("skips empty assistant messages", () => {
    const items = [
      item("assistant_message", "details", 1_000),
      item("assistant_message", " ", 2_000),
    ];
    expect(speakReplyDetailsMessage(items, 3_000)?.text).toBe("details");
  });
});

describe("speakReplyLinkTarget", () => {
  it("sends thread and web links to the main window and keeps other links", () => {
    expect(speakReplyLinkTarget("#/env-1/thread-1")).toBe("t3code://threads/env-1/thread-1");
    expect(speakReplyLinkTarget("https://example.com/a")).toBe("https://example.com/a");
    expect(speakReplyLinkTarget("t3code-dev://threads/e/t")).toBe("t3code-dev://threads/e/t");
    expect(speakReplyLinkTarget("#footnote-1")).toBeNull();
    expect(speakReplyLinkTarget("javascript:alert(1)")).toBeNull();
  });
});
