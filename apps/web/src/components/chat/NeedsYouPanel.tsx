import { splitCommitmentProof } from "@t3tools/client-runtime/commitment-proof";
import {
  PERSONAL_AGENT_THREAD_ID,
  type AttentionItem,
  type CommitmentState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { ThreadContextChip } from "../ThreadContextChip";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

/** Plain detail text with its URLs made clickable. */
function DetailText({ text }: { text: string }) {
  const parts: Array<string | { url: string }> = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    parts.push(text.slice(last, match.index), { url: match[0] });
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return (
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <a
            key={index}
            href={part.url}
            target="_blank"
            rel="noreferrer"
            className="text-foreground/80 underline underline-offset-2"
          >
            {part.url}
          </a>
        ),
      )}
    </p>
  );
}

function ThreadChip({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  return <ThreadContextChip record={{ environmentId, threadId, title: threadId }} />;
}

function NeedsYouRow({
  environmentId,
  item,
  busy,
  onToggle,
  onDismiss,
}: {
  environmentId: EnvironmentId;
  item: AttentionItem;
  busy: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const checkboxId = `needs-you-${item.id}`;
  return (
    <li className="group flex gap-2.5 rounded-lg px-1.5 py-2 hover:bg-black/[0.035] dark:hover:bg-white/[0.06]">
      <Checkbox
        id={checkboxId}
        className="mt-0.5"
        checked={item.done}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={item.done ? `Mark "${item.title}" as not done` : `Mark "${item.title}" as done`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label
          htmlFor={checkboxId}
          className={cn(
            "text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]",
            item.done && "text-muted-foreground line-through",
            item.priority === "high" && !item.done && "text-destructive-foreground",
          )}
        >
          {item.title}
        </label>
        {item.detail && !item.done ? <DetailText text={item.detail} /> : null}
        {item.unblocks.length > 0 && !item.done ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span>Unblocks</span>
            {item.unblocks.map((threadId) => (
              <ThreadChip key={threadId} environmentId={environmentId} threadId={threadId} />
            ))}
          </div>
        ) : null}
        {item.sourceThreadId && !item.done ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span>From</span>
            <ThreadChip environmentId={environmentId} threadId={item.sourceThreadId} />
          </div>
        ) : null}
      </div>
      <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Button
          variant="ghost-muted"
          size="icon-xs"
          disabled={busy}
          onClick={onDismiss}
          aria-label={`Remove "${item.title}"`}
        >
          <XIcon />
        </Button>
      </span>
    </li>
  );
}

const STATE_LABEL: Record<CommitmentState, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting on you",
  done: "Done",
};

const STATE_CLASS: Record<CommitmentState, string> = {
  open: "bg-muted text-muted-foreground",
  in_progress: "bg-info/12 text-info-foreground",
  waiting: "bg-warning/12 text-warning-foreground",
  done: "bg-success/12 text-success-foreground",
};

function Badge({ className, children }: { className: string; children: string }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ProofImage({
  environmentId,
  source,
  local,
}: {
  environmentId: EnvironmentId;
  source: string;
  local: boolean;
}) {
  const asset = useAssetUrlState(
    environmentId,
    local ? { _tag: "media-file", threadId: PERSONAL_AGENT_THREAD_ID, path: source } : null,
  );
  const url = local ? (asset._tag === "Success" ? asset.url : null) : source;
  const name = source.split("/").pop() ?? source;
  if (url === null) {
    return <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{name}</span>;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" title={source} className="block">
      <img
        src={url}
        alt={name}
        className="max-h-28 w-full rounded-md border border-border/65 object-cover object-top"
      />
    </a>
  );
}

/** Proof text with its screenshots as thumbnails and its links clickable. */
function ProofView({ environmentId, proof }: { environmentId: EnvironmentId; proof: string }) {
  const parts = splitCommitmentProof(proof);
  const images = parts.flatMap((part) => (part.type === "image" ? [part] : []));
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <span className="font-medium text-foreground/80">Proof: </span>
        {parts.map((part, index) =>
          part.type === "text" ? (
            part.text
          ) : part.type === "link" ? (
            <a
              key={index}
              href={part.url}
              target="_blank"
              rel="noreferrer"
              className="text-foreground/80 underline underline-offset-2"
            >
              {part.url}
            </a>
          ) : (
            <span key={index}>{part.source.split("/").pop()}</span>
          ),
        )}
      </p>
      {images.length > 0 ? (
        <div className="grid grid-cols-2 gap-1.5">
          {images.map((image) => (
            <ProofImage
              key={image.source}
              environmentId={environmentId}
              source={image.source}
              local={image.local}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A commitment the personal agent owns. Only the agent closes it, with proof. */
function InFlightRow({ environmentId, item }: { environmentId: EnvironmentId; item: AttentionItem }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg px-1.5 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <Badge className={STATE_CLASS[item.state]}>{STATE_LABEL[item.state]}</Badge>
        {item.repeated ? (
          <Badge className="bg-destructive/12 text-destructive-foreground">Repeated</Badge>
        ) : null}
        {item.askedAt ? (
          <span className="ml-auto text-[11px] text-muted-foreground">Asked {item.askedAt}</span>
        ) : null}
      </div>
      <p
        className={cn(
          "text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]",
          item.done && "text-muted-foreground",
        )}
      >
        {item.title}
      </p>
      {item.detail && !item.done ? <DetailText text={item.detail} /> : null}
      {item.ownerThreadId ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>Owner</span>
          <ThreadChip environmentId={environmentId} threadId={item.ownerThreadId} />
        </div>
      ) : null}
      {item.proofRequired && !item.done ? (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <span className="font-medium text-foreground/80">Proof needed: </span>
          {item.proofRequired}
        </p>
      ) : null}
      {item.proof && item.done ? (
        <ProofView environmentId={environmentId} proof={item.proof} />
      ) : null}
    </li>
  );
}

/**
 * The personal agent's Needs you list: what only the user can do. Ticking an
 * item wakes the personal agent to check it and resume the threads it unblocks.
 */
export function NeedsYouPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const { data, error } = useEnvironmentQuery(
    serverEnvironment.attentionItemsLive({ environmentId, input: {} }),
  );
  const setDone = useAtomCommand(serverEnvironment.setAttentionItemDone, {
    label: "Needs you item done",
  });
  const dismiss = useAtomCommand(serverEnvironment.dismissAttentionItem, {
    label: "Needs you item remove",
  });
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const canOperate = useAtomValue(
    serverEnvironment.setAttentionItemDone.permissionAtom(environmentId),
  );

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyIds((current) => new Set(current).add(id));
    await action();
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const items = data?.items ?? [];
  const needsYou = items.filter((item) => item.kind === "needs_you");
  const open = needsYou.filter((item) => !item.done);
  const done = needsYou.filter((item) => item.done);
  const inFlight = items.filter((item) => item.kind === "in_flight");
  const inFlightOpen = inFlight.filter((item) => !item.done);
  const inFlightDone = inFlight.filter((item) => item.done);
  const inFlightRow = (item: AttentionItem) => (
    <InFlightRow key={item.id} environmentId={environmentId} item={item} />
  );
  const row = (item: AttentionItem) => (
    <NeedsYouRow
      key={item.id}
      environmentId={environmentId}
      item={item}
      busy={!canOperate || busyIds.has(item.id)}
      onToggle={() =>
        void run(item.id, () =>
          setDone({ environmentId, input: { id: item.id, done: !item.done } }),
        )
      }
      onDismiss={() => void run(item.id, () => dismiss({ environmentId, input: { id: item.id } }))}
    />
  );

  return (
    <aside
      aria-label="Needs you"
      className="hidden h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-border/65 bg-background lg:flex"
    >
      <ThreadDetailsSection
        headingId="needs-you-open"
        title={open.length > 0 ? `Needs you · ${open.length}` : "Needs you"}
        separated={false}
      >
        {error ? (
          <p className="px-1.5 text-xs text-muted-foreground">{error}</p>
        ) : open.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            Nothing needs you right now. Your personal agent adds sign-ins, decisions and questions
            here when work is waiting on you.
          </p>
        ) : (
          <ul className="flex flex-col">{open.map(row)}</ul>
        )}
      </ThreadDetailsSection>
      {done.length > 0 ? (
        <ThreadDetailsSection headingId="needs-you-done" title="Done this week">
          <ul className="flex flex-col">{done.map(row)}</ul>
        </ThreadDetailsSection>
      ) : null}
      <ThreadDetailsSection
        headingId="in-flight-open"
        title={inFlightOpen.length > 0 ? `In flight · ${inFlightOpen.length}` : "In flight"}
      >
        {inFlightOpen.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            Nothing in flight. What you ask your personal agent for is tracked here until it is done
            and proven.
          </p>
        ) : (
          <ul className="flex flex-col">{inFlightOpen.map(inFlightRow)}</ul>
        )}
      </ThreadDetailsSection>
      {inFlightDone.length > 0 ? (
        <ThreadDetailsSection headingId="in-flight-done" title="Delivered this week">
          <ul className="flex flex-col">{inFlightDone.map(inFlightRow)}</ul>
        </ThreadDetailsSection>
      ) : null}
    </aside>
  );
}
