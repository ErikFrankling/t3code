import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  dictationMarker,
  MessageId,
  type DesktopSpeakReplyPhase,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import {
  type MouseEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { observeResize } from "../../lib/observeResize";
import { useProject, useThreadShell, useThreadVisibleTurnItems } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import ChatMarkdown from "../ChatMarkdown";
import { inputSourceFor, useInputDevice } from "../../inputSource";
import { announceDictationRecording, dictationRecorder } from "../chat/Dictation";
import { DictationCard, DictationTranscriptText } from "../chat/DictationCard";
import { useDesktopDictationSend } from "../chat/desktopDictationSend";
import {
  microphoneError,
  startDictationCapture,
  type DictationCapture,
} from "../chat/dictationCapture";
import { recordingSeconds, type DictationHandoff } from "../chat/dictationRecorder";
import { Button } from "../ui/button";
import {
  speakReplyDetailsMessage,
  speakReplyLinkTarget,
  speakReplyThreadUrl,
} from "./speakReplyDetails";

/** With no words in the live preview by then, the empty recording is dropped. */
export const SPEAK_REPLY_SILENCE_MS = 30_000;
// A level this high in the last few seconds means someone is talking and the
// transcript has not caught up yet.
const VOICE_LEVEL = 0.12;
const VOICE_GRACE_MS = 4_000;

function duration(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function closeWindow() {
  const bridge = window.desktopBridge?.speakReply;
  if (bridge) void bridge.close();
  else window.close();
}

function openInMain(url: string) {
  const bridge = window.desktopBridge?.speakReply;
  if (bridge) void bridge.openInMain(url);
  else window.open(url, "_blank", "noopener");
}

export interface SpeakReplyPageState {
  readonly threadId: ThreadId;
  readonly phase: DesktopSpeakReplyPhase;
  readonly recording: boolean;
  readonly heard: boolean;
}

/**
 * The speak-reply window: the line the agent just spoke, the chat message it
 * is about, and Erik's answer recorded with the composer's durable dictation.
 * Recordings use the thread's composer target, so a cancelled one waits there
 * as a paused recording, and Send hands it to the server exactly like a
 * dictated send.
 */
export function SpeakReplyWindow({
  environmentId,
  threadId,
  text,
  queuedAt,
  onStateChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  text: string;
  queuedAt: number;
  onStateChange: (state: SpeakReplyPageState) => void;
}) {
  const engine = dictationRecorder();
  const all = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const threadRef = scopeThreadRef(environmentId, threadId);
  const thread = useThreadShell(threadRef);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const details = speakReplyDetailsMessage(useThreadVisibleTurnItems(threadRef), queuedAt);
  const target = scopedThreadKey(threadRef);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const inputDevice = useInputDevice();

  const [phase, setPhase] = useState<DesktopSpeakReplyPhase>("starting");
  const [problem, setProblem] = useState("");
  const [, setLevel] = useState(0);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const capture = useRef<DictationCapture | null>(null);
  const mounted = useRef(true);
  const lastVoiceAt = useRef(0);
  const transcriptPanel = useRef<HTMLDivElement>(null);

  const entry = recordingId ? all.find((item) => item.record.id === recordingId) : undefined;
  const server = entry?.record.server ?? null;
  const heard = (server?.final.trim() || server?.draft.trim() || "").length > 0;
  const seconds = entry ? recordingSeconds(entry.record) : 0;
  const recording = phase === "recording";

  useEffect(() => {
    onStateChange({ threadId, phase, recording, heard });
  }, [onStateChange, threadId, phase, recording, heard]);

  const stopMicrophone = () => {
    const running = capture.current;
    capture.current = null;
    running?.stop();
    setLevel(0);
    return running?.id ?? null;
  };

  // A paused recording resumes under its own id; otherwise a new one starts.
  const startRecording = useEffectEvent(async (resumeId: string | null = null) => {
    if (capture.current) return;
    setPhase("starting");
    setProblem("");
    try {
      const started = await startDictationCapture({
        engine,
        id: resumeId,
        target,
        environmentId,
        project: thread?.worktreePath ?? project?.workspaceRoot ?? "",
        threadId,
        stillWanted: () => mounted.current,
        onLevel: (value) => {
          if (value >= VOICE_LEVEL) lastVoiceAt.current = Date.now();
          if (mounted.current) setLevel(value);
        },
        onLimit: () => void stopMicrophone(),
      });
      capture.current = started;
      lastVoiceAt.current = 0;
      announceDictationRecording();
      setRecordingId(started.id);
      setPhase("recording");
    } catch (cause) {
      if (!mounted.current) return;
      setProblem(microphoneError(cause));
      setPhase("error");
    }
  });

  useEffect(() => {
    mounted.current = true;
    void startRecording();
    const flush = () => capture.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", flush);
      // Replaced by a message for another thread, or closed: the recording
      // stays, paused, in this thread's composer.
      const id = stopMicrophone();
      if (id) engine.pause(id);
    };
  }, [engine]);

  // Silence rule: nothing said in the first 30 s drops the empty recording.
  const checkSilence = useEffectEvent(() => {
    if (phase !== "recording" || heard || !recordingId) return false;
    if (Date.now() - lastVoiceAt.current < VOICE_GRACE_MS) return true;
    stopMicrophone();
    void engine.remove(recordingId);
    setRecordingId(null);
    setPhase("silent");
    return false;
  });
  useEffect(() => {
    if (phase !== "recording" || heard) return;
    let timer = window.setTimeout(function tick() {
      if (checkSilence()) timer = window.setTimeout(tick, 1_000);
    }, SPEAK_REPLY_SILENCE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, heard]);

  const handoff: DictationHandoff = async (serverId, draft, uploaded) => {
    if (!thread) throw new Error("The thread is not loaded yet.");
    const { runtimeMode, interactionMode } = thread;
    await uploaded;
    const result = await startTurn({
      environmentId,
      input: {
        commandId: CommandId.make(serverId),
        dictation: { id: serverId, draft },
        inputSource: inputSourceFor({
          device: inputDevice,
          dictated: true,
          via: "speak reply window",
        }),
        threadId,
        message: {
          messageId: MessageId.make(serverId),
          role: "user",
          text: dictationMarker(serverId),
          attachments: [],
        },
        runtimeMode,
        interactionMode,
        // The server picks the mode when it sends the final transcript: it
        // steers a run in progress, so a busy agent hears the answer at once,
        // and starts a turn otherwise.
        dispatchMode: "steer",
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("The thread refused the message.");
    }
  };

  const pause = useEffectEvent(() => {
    if (phase !== "recording" || !recordingId) return;
    stopMicrophone();
    engine.pause(recordingId);
    setPhase("paused");
  });
  const pauseOrResume = () => {
    if (phase === "recording") pause();
    else if (phase === "paused" && recordingId) void startRecording(recordingId);
    else if (phase === "silent" || phase === "error") void startRecording();
  };

  const send = useEffectEvent(async () => {
    if ((phase !== "recording" && phase !== "paused") || !recordingId) return;
    stopMicrophone();
    setPhase("sending");
    const id = recordingId;
    await engine.send(id, handoff);
    const after = engine.getSnapshot().find((item) => item.record.id === id);
    if (after?.record.notice) {
      // Refused: the recording is kept, paused, in the thread's composer.
      setProblem(after.record.notice);
      setRecordingId(null);
      setPhase("error");
      return;
    }
    // The server holds the turn now and sends it when the transcript is final.
    closeWindow();
  });

  // Enter anywhere on the desktop (Erik's Hyprland bind) sends, like the Send button.
  useDesktopDictationSend(recording, () => void send());

  const cancel = useEffectEvent(() => {
    if (phase === "sending") return;
    const id = stopMicrophone() ?? recordingId;
    const stored = id ? engine.getSnapshot().find((item) => item.record.id === id) : undefined;
    if (id && stored && stored.record.sizes.length === 0) void engine.remove(id);
    else if (id) engine.pause(id);
    closeWindow();
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
      else if (event.key === "Enter" && !event.shiftKey) void send();
      else if (event.key === " ") pauseOrResume();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    const unsubscribe = window.desktopBridge?.speakReply?.onCommand((command) => {
      if (command === "send") void send();
      else cancel();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const panel = transcriptPanel.current;
    const inner = panel?.firstElementChild;
    if (!panel || !inner) return;
    return observeResize(inner, () => {
      panel.scrollTop = panel.scrollHeight;
    });
  }, []);

  const openDetails = () => openInMain(speakReplyThreadUrl(environmentId, threadId));
  // Links in the preview open in the main window, never in this small one.
  const onPreviewClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    const url = speakReplyLinkTarget(href);
    if (url === null) return;
    event.preventDefault();
    event.stopPropagation();
    openInMain(url);
  };

  const refined = server?.final.trim() ?? "";
  const live = server?.draft.trim() ?? "";
  const tail = refined ? live.split(/\s+/).slice(refined.split(/\s+/).length).join(" ") : live;

  const status =
    phase === "starting"
      ? "Starting the microphone…"
      : recording
        ? `Recording now · ${duration(seconds)}`
        : phase === "paused"
          ? `Paused · ${duration(seconds)}`
          : phase === "sending"
            ? "Sending…"
            : phase === "silent"
              ? "Stopped: nothing was said"
              : "Not recording";

  // The same card the composer dictates in (DictationCard), filling this window.
  return (
    <div className="h-dvh bg-background">
      <DictationCard
        fill
        testId="speak-reply"
        className="rounded-none border-0"
        status={status}
        listening={recording}
        headerActions={
          <>
            <Button variant="ghost" size="xs" className="drag-none" onClick={openDetails}>
              <ExternalLinkIcon />
              Open details
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Cancel (Esc); the recording stays in the thread"
              onClick={cancel}
            >
              <XIcon />
            </Button>
          </>
        }
        message={
          <div onClickCapture={onPreviewClick}>
            <p className="whitespace-pre-wrap font-medium text-foreground leading-snug">{text}</p>
            {details ? (
              <div data-testid="speak-reply-details" className="mt-2 border-t pt-2 text-xs">
                <ChatMarkdown
                  text={details.text}
                  cwd={thread?.worktreePath ?? project?.workspaceRoot}
                  threadRef={threadRef}
                  environmentId={environmentId}
                />
              </div>
            ) : null}
          </div>
        }
        body={
          <div
            ref={transcriptPanel}
            data-testid="speak-reply-transcript"
            className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-sm"
          >
            <DictationTranscriptText
              refined={refined}
              tail={tail}
              placeholder={
                recording
                  ? "Speak; your words appear here."
                  : phase === "silent"
                    ? "Press Record to answer."
                    : phase === "paused"
                      ? "Paused: Resume to go on, or Send what you said."
                      : ""
              }
            />
          </div>
        }
        {...(problem ? { problem } : {})}
        pauseLabel={recording ? "Pause" : phase === "paused" ? "Resume" : "Record"}
        onPauseResume={pauseOrResume}
        pauseDisabled={phase === "starting" || phase === "sending"}
        onSend={() => void send()}
        sendDisabled={(phase !== "recording" && phase !== "paused") || seconds === 0}
        hint="Enter send · Space pause · Esc close"
      />
    </div>
  );
}
