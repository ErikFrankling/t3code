import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  PERSONAL_AGENT_THREAD_ID,
  todoAge,
  todoChip,
  todoSection,
  type AttentionItem,
  type EnvironmentId,
  type TodoChipTone,
  type TodoSection,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { ThreadContextChip } from "../ThreadContextChip";
import { Checkbox } from "../ui/checkbox";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";

const TONE_CLASS: Record<TodoChipTone, string> = {
  attention: "bg-warning/14 text-warning-foreground",
  active: "bg-info/12 text-info-foreground",
  waiting: "bg-muted text-muted-foreground",
  muted: "bg-muted text-muted-foreground",
  done: "bg-success/12 text-success-foreground",
};

const NEEDS_YOU_CAP = 5;

const SECTION_TITLE: Record<TodoSection, string> = {
  needs_you: "Needs you",
  moving: "Moving",
  waiting: "Waiting",
  standing: "Standing rules",
  done: "Done this week",
};

function TodoRow({
  environmentId,
  item,
  now,
  canTick,
  busy,
  onToggle,
}: {
  environmentId: EnvironmentId;
  item: AttentionItem;
  now: number;
  canTick: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const section = todoSection(item, now);
  const chip = todoChip(item, now);
  const age = todoAge(item, now);
  const needsYou = section === "needs_you";
  return (
    <li className={cn("rounded-lg px-1.5 py-1.5", needsYou && "bg-warning/6", "hover:bg-muted/60")}>
      <div className="flex items-start gap-2">
        {needsYou ? (
          <Checkbox
            className="mt-0.5"
            checked={item.erikTicked !== null}
            disabled={!canTick || busy}
            onCheckedChange={onToggle}
            aria-label={
              item.erikTicked !== null
                ? `Untick "${item.title}"`
                : `Tick "${item.title}" as done and tell the personal agent`
            }
          />
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-1 text-left"
        >
          <ChevronRightIcon
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span
              className={cn(
                "text-sm leading-snug [overflow-wrap:anywhere]",
                section === "done" ? "text-muted-foreground" : "text-foreground",
                needsYou && "font-medium",
              )}
            >
              {item.title}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "rounded px-1.5 py-px text-2xs font-semibold uppercase tracking-wide",
                  TONE_CLASS[chip.tone],
                )}
              >
                {chip.label}
              </span>
              {item.repeated > 0 && section !== "done" ? (
                <span className="rounded bg-destructive/12 px-1.5 py-px text-2xs font-semibold uppercase tracking-wide text-destructive-foreground">
                  Repeated{item.repeated > 1 ? ` ×${item.repeated}` : ""}
                </span>
              ) : null}
              {age ? <span className="text-2xs text-muted-foreground">{age}</span> : null}
            </span>
          </span>
        </button>
      </div>
      {open ? (
        <div className="mt-1.5 flex flex-col gap-1.5 pl-5">
          {item.owner && item.owner !== PERSONAL_AGENT_THREAD_ID ? (
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span>Owner</span>
              <ThreadContextChip
                record={{ environmentId, threadId: item.owner, title: item.owner }}
              />
            </div>
          ) : null}
          {item.body.length > 0 ? (
            <ChatMarkdown
              text={item.body}
              cwd={undefined}
              environmentId={environmentId}
              threadRef={scopeThreadRef(environmentId, PERSONAL_AGENT_THREAD_ID)}
              headingLevelOffset={3}
              className="text-xs"
            />
          ) : null}
          <p className="text-2xs text-muted-foreground">todo/{item.id}.md</p>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The personal agent's one to-do list, read live from its `todo/*.md` files.
 * Items that wait on the user are marked Needs you and come first; ticking one
 * records it in the file and wakes the personal agent to verify it.
 */
export function TodoList({
  environmentId,
  items,
}: {
  environmentId: EnvironmentId;
  items: ReadonlyArray<AttentionItem>;
}) {
  const setTicked = useAtomCommand(serverEnvironment.setAttentionItemDone, {
    label: "To-do item tick",
  });
  const canTick = useAtomValue(
    serverEnvironment.setAttentionItemDone.permissionAtom(environmentId),
  );
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [showFolded, setShowFolded] = useState(false);
  const [showAllNeedsYou, setShowAllNeedsYou] = useState(false);
  // The minute is UTC without a zone suffix.
  const now = Date.parse(`${useNowMinute()}:00Z`);

  const toggle = async (item: AttentionItem) => {
    setBusyIds((current) => new Set(current).add(item.id));
    await setTicked({ environmentId, input: { id: item.id, done: item.erikTicked === null } });
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
  };

  const bySection = new Map<TodoSection, AttentionItem[]>();
  for (const item of items) {
    const section = todoSection(item, now);
    bySection.set(section, [...(bySection.get(section) ?? []), item]);
  }
  const folded = [...(bySection.get("standing") ?? []), ...(bySection.get("done") ?? [])];

  const sectionList = (section: TodoSection, separated = true) => {
    const rows = bySection.get(section) ?? [];
    if (rows.length === 0) return null;
    // A long Needs you list would push everything else out of reach.
    const capped = section === "needs_you" && !showAllNeedsYou && rows.length > NEEDS_YOU_CAP;
    const visible = capped ? rows.slice(0, NEEDS_YOU_CAP) : rows;
    return (
      <ThreadDetailsSection
        key={section}
        headingId={`todo-${section}`}
        title={`${SECTION_TITLE[section]} · ${rows.length}`}
        separated={separated}
      >
        <ul className="flex flex-col gap-0.5">
          {visible.map((item) => (
            <TodoRow
              key={item.id}
              environmentId={environmentId}
              item={item}
              now={now}
              canTick={canTick}
              busy={busyIds.has(item.id)}
              onToggle={() => void toggle(item)}
            />
          ))}
        </ul>
        {section === "needs_you" && rows.length > NEEDS_YOU_CAP ? (
          <button
            type="button"
            onClick={() => setShowAllNeedsYou((current) => !current)}
            className="mt-1 w-full rounded-md px-1.5 py-1 text-left text-xs font-medium text-warning-foreground hover:bg-muted/60"
          >
            {capped ? `Show ${rows.length - NEEDS_YOU_CAP} more` : "Show fewer"}
          </button>
        ) : null}
      </ThreadDetailsSection>
    );
  };

  return (
    <div className="flex flex-col">
      {items.length === 0 ? (
        <p className="px-3.5 py-2 text-xs text-muted-foreground">
          Nothing on the list. Your personal agent keeps it in its todo/ folder.
        </p>
      ) : null}
      {sectionList("needs_you", false)}
      {sectionList("moving", (bySection.get("needs_you")?.length ?? 0) > 0)}
      {sectionList("waiting")}
      {folded.length > 0 ? (
        <div className="border-t border-border/65 px-2 py-2">
          <button
            type="button"
            onClick={() => setShowFolded((current) => !current)}
            aria-expanded={showFolded}
            className="flex w-full items-center gap-1 px-1.5 py-1 text-2xs font-medium text-muted-foreground"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", showFolded && "rotate-90")}
            />
            Standing rules and done · {folded.length}
          </button>
        </div>
      ) : null}
      {showFolded ? (
        <>
          {sectionList("standing")}
          {sectionList("done")}
        </>
      ) : null}
    </div>
  );
}
