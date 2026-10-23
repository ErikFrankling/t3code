import {
  ReadAloudPlayer,
  readAloudSpeed,
  type ReadAloudAudio,
} from "@t3tools/client-runtime/read-aloud";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { voiceLoopCueWav } from "@t3tools/client-runtime/voice-loop";
import { ReadAloudState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import { fetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";

import { voiceCall } from "../../native/voiceCall";
import { reportReadAloudPlayed, setActivityConnection } from "./activityLog";
import { createReadAloudAudio } from "./readAloudAudio";

/**
 * Read-aloud on the phone: the environment writes a short spoken summary with
 * its local models and streams the audio sentence by sentence (the server's
 * `/api/read-aloud`, shared with web and desktop); the shared player in
 * client-runtime drives it, this file only plays the clips.
 */
const decodeReadAloudState = Schema.decodeUnknownSync(ReadAloudState);

let connection: PreparedConnection | null = null;

let backgroundPlayback: boolean | null = null;
let clipNumber = 0;

const mediaAudio = createReadAloudAudio({
  createPlayer: () => createAudioPlayer(null, { updateInterval: 250 }),
  writeClip: async (base64) => {
    // Rotating files: neither the playing nor the preloaded clip is overwritten.
    const file = new File(Paths.cache, `read-aloud-${clipNumber++ % 6}.wav`);
    await file.write(base64, { encoding: "base64" });
    return file.uri;
  },
  prepare: async () => {
    // Voice mode reads replies with the screen off; otherwise reading stops when you leave.
    if (backgroundPlayback !== voiceCall.active) {
      backgroundPlayback = voiceCall.active;
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: backgroundPlayback,
      });
    }
    // Dictation turns the audio session off when it stops recording; playback needs it on.
    await setIsAudioActiveAsync(true);
  },
});

/** Frees the players (voice mode drops them while you talk; see readAloudAudio.ts). */
export function releaseReadAloudAudio() {
  mediaAudio.release();
}

// Clips handed to the call's player and not yet heard.
const queuedInCall = new Set<string>();
let rejectInCall: ((error: Error) => void) | null = null;
let rateInCall = 1;

/**
 * During voice mode's call, replies play on the call's own speaker (one
 * AudioTrack on the call's route, clips strictly one after another), never
 * through expo-audio: a media player would pull a Bluetooth headset out of
 * its call profile, and expo-audio's audio-mode calls reset the call's mode.
 */
const callAudio: ReadAloudAudio = {
  play: (clip, { rate, startFraction, next, onProgress }) =>
    new Promise<void>((resolve, reject) => {
      const native = voiceCall.native;
      if (!native) return reject(new Error("Voice mode is not on."));
      rejectInCall?.(new Error("replaced"));
      rateInCall = rate;
      const queue = (id: string, wav: string, fraction: number) => {
        queuedInCall.add(id);
        return native.play(id, wav, rate, fraction);
      };
      if (!queuedInCall.has(clip.id) || startFraction) {
        native.clearPlayback();
        queuedInCall.clear();
        queue(clip.id, clip.audio, startFraction ?? 0).catch(reject);
      }
      if (next && !queuedInCall.has(next.id)) queue(next.id, next.audio, 0).catch(() => undefined);
      const finish = () => {
        unsubscribe();
        if (rejectInCall === fail) rejectInCall = null;
      };
      const fail = (error: Error) => {
        finish();
        reject(error);
      };
      const unsubscribe = voiceCall.onEvent((event) => {
        if (event.type === "progress" && event.id === clip.id) onProgress?.(event.fraction);
        if (event.type === "ended" && event.id === clip.id) {
          queuedInCall.delete(clip.id);
          finish();
          resolve();
        }
      });
      rejectInCall = fail;
    }),
  // The next chunk, the moment it arrives: queued behind the one playing.
  preload: (clip) => {
    const native = voiceCall.native;
    if (!native || queuedInCall.size === 0 || queuedInCall.has(clip.id)) return;
    queuedInCall.add(clip.id);
    void native.play(clip.id, clip.audio, rateInCall, 0).catch(() => undefined);
  },
  pause: () => voiceCall.native?.pausePlayback(),
  resume: () => voiceCall.native?.resumePlayback(),
  stop: () => {
    if (voiceCall.active) voiceCall.native?.clearPlayback();
    queuedInCall.clear();
    rejectInCall?.(new Error("stopped"));
  },
};

/** Voice mode's call plays its replies itself; otherwise expo-audio, one voice at a time. */
const audio: ReadAloudAudio = {
  play: (clip, options) => (voiceCall.active ? callAudio : mediaAudio).play(clip, options),
  preload: (clip) => (voiceCall.active ? callAudio : mediaAudio).preload?.(clip),
  setRate: (rate) => {
    if (!voiceCall.active) mediaAudio.setRate?.(rate);
  },
  pause: () => (voiceCall.active ? callAudio : mediaAudio).pause(),
  resume: () => (voiceCall.active ? callAudio : mediaAudio).resume(),
  stop: () => {
    callAudio.stop();
    mediaAudio.stop();
  },
};

/**
 * Voice mode's "recording" sound, straight on the audio (the call's speaker during
 * a call): not through the read-aloud player, whose controls would flash for it.
 */
export function playVoiceCue(): Promise<void> {
  return audio.play({ id: `cue:${Date.now()}`, audio: voiceLoopCueWav() }, { rate: 1 });
}

// The chosen speed outlives the app: read once at startup, written on every change.
const speedFile = new File(Paths.document, "read-aloud-speed.json");

export const readAloudPlayer = new ReadAloudPlayer({
  audio,
  onSpeedChange: (speed) => {
    void Promise.resolve(speedFile.write(JSON.stringify({ speed }))).catch(() => undefined);
  },
  onPlayed: reportReadAloudPlayed,
  request: async (body) => {
    const authorization = connection?.httpAuthorization ?? null;
    if (!connection || authorization?._tag === "Dpop") {
      throw new Error("Read aloud needs a direct connection to your computer.");
    }
    const response = await fetch(new URL("/api/read-aloud", connection.httpBaseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return decodeReadAloudState(await response.json());
  },
});

void (async () => {
  if (!speedFile.exists) return;
  const stored = readAloudSpeed((JSON.parse(await speedFile.text()) as { speed?: unknown }).speed);
  if (readAloudPlayer.getSnapshot().speed !== stored) readAloudPlayer.setSpeed(stored);
})().catch(() => undefined);

export const useReadAloud = () =>
  useSyncExternalStore(readAloudPlayer.subscribe, readAloudPlayer.getSnapshot);

/** Points read-aloud at an environment's connection. */
export function setReadAloudConnection(next: PreparedConnection | null) {
  connection = next;
  setActivityConnection(next);
}

/** The connection read-aloud uses; voice mode's presence polls go over it too. */
export function readAloudConnection(): PreparedConnection | null {
  return connection;
}
