import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * A whole voice-mode session on Android must switch the phone into
 * communication mode once, at the start, and out once, at the end: a Bluetooth
 * headset glitches every time it is moved in or out of its call profile.
 *
 * The session runs through the real voice mode, loop, read-aloud player and
 * dictation audio setup; only the edges are fakes. The native call module
 * records what it is asked to do, and expo-audio records every call that
 * touches the audio mode, focus or a media player, since any of those mid-call
 * moves the headset off the call (expo-audio's setAudioModeAsync resets the
 * mode to NORMAL).
 */
const log: string[] = [];
const listeners = new Set<(event: { type: string; id?: string }) => void>();
const recording = { on: false };

const native = {
  start: () => log.push("call start"),
  stop: () => log.push("call stop"),
  isActive: () => false,
  setListening: () => undefined,
  route: () => ({ kind: "bluetooth", name: "Headset" }),
  audioLog: () => "",
  play: async (id: string) => {
    log.push(`play ${id}`);
    // Heard a moment later, as the native player reports it.
    setTimeout(() => {
      for (const listener of listeners) listener({ type: "ended", id });
    }, 1);
  },
  clearPlayback: () => log.push("clear"),
  pausePlayback: () => log.push("pause"),
  resumePlayback: () => log.push("resume"),
  prepareRecording: () => "file:///cache/voice-call.aac",
  startRecording: async () => {
    log.push("turn start");
    recording.on = true;
  },
  stopRecording: async () => {
    log.push("turn end");
    recording.on = false;
  },
  recordingStatus: () => ({
    isRecording: recording.on,
    durationMillis: 0,
    metering: -160,
    bluetooth: true,
  }),
  addListener: (_event: string, listener: (event: { type: string; id?: string }) => void) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
};

vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppRegistry: { registerHeadlessTask: () => undefined },
}));
vi.mock("expo-audio", () => ({
  AudioModule: {},
  getRecordingPermissionsAsync: async () => ({ granted: true }),
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => log.push("expo-audio setAudioModeAsync"),
  setIsAudioActiveAsync: async () => log.push("expo-audio setIsAudioActiveAsync"),
  createAudioPlayer: () => {
    log.push("expo-audio player");
    return {
      playing: false,
      play: () => undefined,
      pause: () => undefined,
      replace: () => undefined,
      seekTo: async () => undefined,
      setPlaybackRate: () => undefined,
      addListener: () => ({ remove: () => undefined }),
      remove: () => undefined,
    };
  },
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "/cache", document: "/documents" },
  File: class {
    exists = false;
    uri = "file:///cache/clip.wav";
    async write() {}
    async text() {
      return "{}";
    }
  },
}));
// What the agent has to say, handed to the phone.s presence poll.
const presenceQueue: { id: string; text: string }[] = [];
// The server's read-aloud: every sentence of the text is ready at once.
vi.mock("expo/fetch", () => ({
  fetch: async (url: string, init: { body: string }) => {
    if (url.includes("/api/voice-presence")) {
      const { waitMs } = JSON.parse(init.body) as { waitMs: number };
      // A long poll: held until there is something to say.
      for (let i = 0; waitMs > 0 && presenceQueue.length === 0 && i < 1500; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const utterances = waitMs > 0 ? presenceQueue.splice(0) : [];
      return { ok: true, json: async () => ({ utterances }) };
    }
    const body = JSON.parse(init.body) as { text?: string; id?: string };
    const text = body.text ?? "";
    return {
      ok: true,
      json: async () => ({
        id: `job:${text}`,
        status: "complete",
        voice: "small",
        error: "",
        sentences: [{ text, ready: true, audio: "UklGRg==", span: 1 }],
      }),
    };
  },
}));

const { voiceMode, voiceSession, registerVoiceModeComposer, registerVoiceModeController } =
  await import("./voiceMode");
const { readAloudPlayer, setReadAloudConnection } = await import("../threads/readAloudPlayback");
const { configureVoiceRecordingAudio, releaseVoiceRecordingAudio } =
  await import("../voice-input/voiceRecordingAudio");

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 2000 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  if (!check())
    throw new Error(`Timed out waiting for ${what} (${voiceSession.getSnapshot().phase})`);
};

let turn = 0;

beforeEach(() => {
  log.length = 0;
  turn = 0;
  setReadAloudConnection({ httpBaseUrl: "http://pc:3773", httpAuthorization: null } as never);
  // Dictation into the composer, as the voice input controller does it: the
  // recording's audio setup, the recorder, and sending.
  registerVoiceModeComposer("thread-1", {
    start: async () => {
      await configureVoiceRecordingAudio();
      native.prepareRecording();
      await native.startRecording();
    },
    stop: async () => {
      await native.stopRecording();
      await releaseVoiceRecordingAudio();
      turn++;
      // The agent has something to say a moment later.
      setTimeout(() => presenceQueue.push({ id: `say-${turn}`, text: `Reply ${turn}.` }), 2);
    },
  });
  registerVoiceModeController({
    cancelAndDelete: () => undefined,
    currentState: {
      get phase() {
        return recording.on ? "recording" : "idle";
      },
    },
  } as never);
});

describe("voice mode's call", () => {
  it("switches into communication mode once, keeps it through every turn, and out once at the end", async () => {
    voiceMode.start("thread-1");
    await until(() => voiceSession.getSnapshot().phase === "idle", "voice mode to come on");
    // Erik talks first, unprompted.
    voiceSession.talk();
    await until(() => voiceSession.getSnapshot().phase === "listening", "the first turn");

    for (let round = 1; round <= 3; round++) {
      // A volume key sends; the agent speaks when it has something, then the next turn opens.
      voiceSession.endTurn();
      await until(() => log.includes(`play job:Reply ${round}.:0`), `reply ${round} to be read`);
      if (round === 2) {
        // Paused and resumed while a reply is read.
        readAloudPlayer.togglePause();
        readAloudPlayer.togglePause();
      }
      await until(
        () => voiceSession.getSnapshot().phase === "listening" && recording.on,
        `turn ${round + 1}`,
      );
    }

    voiceMode.stop();
    await until(() => log.includes("call stop"), "the call to end");

    const touchesAudio = (entry: string) =>
      entry.startsWith("call ") || entry.startsWith("expo-audio");
    // Exactly one switch in, at the start, and one out, at the end; nothing in between.
    expect(log.filter(touchesAudio)).toEqual(["call start", "call stop"]);
    expect(log[0]).toBe("call start");
    // Four turns were recorded and every reply was read on the call's player.
    expect(log.filter((entry) => entry === "turn start")).toHaveLength(4);
    for (let round = 1; round <= 3; round++) expect(log).toContain(`play job:Reply ${round}.:0`);
  });

  it("leaves dictation's audio setup alone outside voice mode", async () => {
    await configureVoiceRecordingAudio();
    await releaseVoiceRecordingAudio();
    expect(log).toEqual([
      "expo-audio setAudioModeAsync",
      "expo-audio setIsAudioActiveAsync",
      "expo-audio setAudioModeAsync",
      "expo-audio setIsAudioActiveAsync",
    ]);
  });
});
