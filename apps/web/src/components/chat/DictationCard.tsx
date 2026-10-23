import type { CSSProperties, ReactNode, Ref } from "react";
import { ArrowUpIcon, MicIcon, PauseIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * The small dictation card: one design for every place Erik dictates without
 * full screen (the composer's card, the speak-reply window after the agent
 * spoke). Visuals only; the recording itself is the caller's. Status line with
 * a dot that pulses while recording, an optional message to reply to, the
 * transcript, and the controls: Delete, Edit, Pause/Resume (labelled), Send.
 */
export function DictationCard({
  cardRef,
  ...props
}: {
  readonly cardRef?: Ref<HTMLDivElement>;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly testId?: string;
  /** Fill the container (a small window) instead of sizing to the content. */
  readonly fill?: boolean;
  readonly status: string;
  readonly listening: boolean;
  /** Between the status and the header actions (recording tabs). */
  readonly headerMiddle?: ReactNode;
  readonly headerActions?: ReactNode;
  /** What is being replied to, above the transcript (the agent's spoken message). */
  readonly message?: ReactNode;
  /** The transcript area; `DictationTranscriptText` inside a scroller. */
  readonly body: ReactNode;
  readonly problem?: string;
  readonly onDelete?: () => void;
  readonly deleteDisabled?: boolean;
  readonly deleteLabel?: string;
  readonly onEdit?: () => void;
  readonly editDisabled?: boolean;
  readonly pauseLabel: string;
  readonly onPauseResume: () => void;
  readonly pauseDisabled?: boolean;
  readonly onSend: () => void;
  readonly sendDisabled?: boolean;
  readonly hint?: string;
  /** Dialogs and the like, rendered inside the card. */
  readonly children?: ReactNode;
}) {
  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="region"
      aria-label="Dictation"
      data-testid={props.testId}
      data-size="compact"
      className={cn(
        "flex flex-col rounded-2xl border bg-popover text-popover-foreground outline-none",
        props.fill && "h-full",
        props.className,
      )}
      style={props.style}
    >
      <header className="flex items-center gap-1.5 px-3 pt-2.5">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            props.listening ? "animate-pulse bg-destructive" : "bg-muted-foreground/50",
          )}
        />
        <p role="status" className="min-w-0 truncate text-muted-foreground text-xs tabular-nums">
          {props.status || "Dictation"}
        </p>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">{props.headerMiddle}</div>
        {props.headerActions}
      </header>
      {props.message ? (
        <div
          className="shrink-0 overflow-y-auto border-b px-4 py-2 text-muted-foreground text-sm"
          style={{ maxHeight: "40%" }}
        >
          {props.message}
        </div>
      ) : null}
      {props.body}
      {props.problem ? (
        <p role="alert" className="px-4 pb-1 text-destructive text-xs">
          {props.problem}
        </p>
      ) : null}
      <footer className="flex items-center gap-2 border-t px-3 py-2">
        {props.onDelete ? (
          <Button
            variant="ghost-destructive"
            size="sm"
            aria-label={props.deleteLabel ?? "Delete"}
            title={props.deleteLabel ?? "Delete this recording"}
            disabled={props.deleteDisabled}
            onClick={props.onDelete}
          >
            <Trash2Icon />
            <span className="hidden sm:inline">{props.deleteLabel ?? "Delete"}</span>
          </Button>
        ) : null}
        {props.onEdit ? (
          <Button variant="outline" size="sm" disabled={props.editDisabled} onClick={props.onEdit}>
            <PencilIcon />
            Edit
          </Button>
        ) : null}
        {props.hint ? (
          <span className="hidden flex-1 text-center text-muted-foreground text-xs lg:block">
            {props.hint}
          </span>
        ) : null}
        <span className={cn("flex-1", props.hint && "lg:hidden")} />
        {/* Labelled, so recording and paused cannot be mistaken. */}
        <Button
          size="lg"
          variant={props.listening ? "destructive" : "secondary"}
          disabled={props.pauseDisabled}
          onClick={props.onPauseResume}
        >
          {props.listening ? <PauseIcon /> : <MicIcon />}
          {props.pauseLabel}
        </Button>
        <Button size="lg" disabled={props.sendDisabled} onClick={props.onSend}>
          <ArrowUpIcon />
          Send
        </Button>
      </footer>
      {props.children}
    </div>
  );
}

/** Finished words in the normal colour, then what is still being worked out, muted. */
export function DictationTranscriptText(props: {
  readonly refined: string;
  readonly tail: string;
  readonly placeholder: string;
  readonly className?: string;
}) {
  return (
    <p
      aria-live="polite"
      data-testid="dictation-transcript"
      className={cn("whitespace-pre-wrap leading-relaxed", props.className)}
    >
      {props.refined || props.tail ? (
        <>
          <span className="text-foreground">{props.refined}</span>
          {props.refined && props.tail ? " " : ""}
          <span className="text-muted-foreground">{props.tail}</span>
        </>
      ) : (
        <span className="text-muted-foreground">{props.placeholder}</span>
      )}
    </p>
  );
}
