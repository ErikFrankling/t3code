import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  SpeakReplyWindow,
  type SpeakReplyPageState,
} from "../components/speakReply/SpeakReplyWindow";
import { Spinner } from "../components/ui/spinner";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

export const SPEAK_REPLY_WINDOW_TITLE = "T3 Code — Speak reply";

interface SpeakReplySearch {
  readonly threadId: string;
  readonly text: string;
  readonly request: string;
  readonly queuedAt: number | null;
}

interface Content {
  readonly threadId: string;
  readonly text: string;
  readonly queuedAt: number;
}

// Values that look like JSON are decoded by the router; the window needs them as text.
const asText = (value: unknown) =>
  typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);

function SpeakReplyRoute() {
  const search = Route.useSearch();
  // A desktop app that is only a client of a remote server has no primary
  // environment; its server is a saved one.
  const primaryId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environment =
    environments.find((entry) => entry.environmentId === primaryId) ??
    environments.find((entry) => entry.connection.phase === "connected") ??
    environments[0] ??
    null;
  // Opened at: a missing queuedAt means "the latest message now".
  const [openedAt] = useState(() => Date.now());
  const [content, setContent] = useState<Content>({
    threadId: search.threadId,
    text: search.text,
    queuedAt: search.queuedAt ?? openedAt,
  });
  // A new recording starts when this changes.
  const [session, setSession] = useState(0);
  const pageState = useRef<SpeakReplyPageState | null>(null);

  useEffect(() => {
    document.title = SPEAK_REPLY_WINDOW_TITLE;
  }, []);

  const report = (state: SpeakReplyPageState) => {
    pageState.current = state;
    void window.desktopBridge?.speakReply?.reportState(state).catch(() => undefined);
  };

  // A layout effect, so it listens before the page's first report tells the
  // desktop app that this window takes new content.
  useLayoutEffect(
    () =>
      window.desktopBridge?.speakReply?.onContent((next) => {
        const current = pageState.current;
        // Mid-answer to the same thread: keep recording, show the new line.
        const keep =
          current !== null &&
          current.threadId === next.threadId &&
          (current.recording || current.phase === "sending");
        setContent({
          threadId: next.threadId,
          text: next.text,
          queuedAt: next.queuedAt ?? Date.now(),
        });
        if (!keep) setSession((value) => value + 1);
      }),
    [],
  );

  if (!content.threadId)
    return <p className="p-4 text-destructive text-sm">The speak-reply window needs a thread.</p>;
  if (!environment || environment.connection.phase !== "connected")
    return (
      <div className="flex h-dvh items-center justify-center gap-2 bg-background text-muted-foreground text-sm">
        <Spinner />
        Connecting…
      </div>
    );
  return (
    <SpeakReplyWindow
      key={`${content.threadId}:${session}`}
      environmentId={environment.environmentId}
      threadId={ThreadId.make(content.threadId)}
      text={content.text}
      queuedAt={content.queuedAt}
      onStateChange={report}
    />
  );
}

export const Route = createFileRoute("/speak-reply")({
  validateSearch: (raw: Record<string, unknown>): SpeakReplySearch => {
    const queuedAt = Number(raw.queuedAt);
    return {
      threadId: asText(raw.threadId).trim(),
      text: asText(raw.text),
      request: asText(raw.request),
      queuedAt: Number.isFinite(queuedAt) && raw.queuedAt !== undefined ? queuedAt : null,
    };
  },
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: SpeakReplyRoute,
});
