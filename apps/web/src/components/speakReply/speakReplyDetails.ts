import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type AssistantMessage = Extract<
  OrchestrationV2ProjectedTurnItem["item"],
  { type: "assistant_message" }
>;

/**
 * The message the spoken line is about: the agent posts the details right
 * before it speaks, so it is the latest assistant message that existed when
 * the line was queued.
 */
export function speakReplyDetailsMessage(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  queuedAt: number,
): AssistantMessage | null {
  let found: AssistantMessage | null = null;
  for (const { item } of items) {
    if (item.type !== "assistant_message" || !item.text.trim()) continue;
    const at = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
    if (at <= queuedAt) found = item;
  }
  return found;
}

/**
 * Where a link clicked in the window's preview opens: everything goes to the
 * main window, which knows how to open threads and web pages. `null` keeps
 * the click in the window (anchors within the preview).
 */
export function speakReplyLinkTarget(href: string): string | null {
  // In-app links are hash routes: #/<environmentId>/<threadId>.
  const route = /^#\/([^/?#]+)\/([^/?#]+)\/?$/.exec(href);
  if (route) return `t3code://threads/${route[1]}/${route[2]}`;
  if (/^t3code(?:-[a-z]+)?:\/\/threads\//.test(href) || /^https?:\/\//.test(href)) return href;
  return null;
}

export function speakReplyThreadUrl(environmentId: string, threadId: string): string {
  return `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}
