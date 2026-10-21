import type { ReadAloudAudio, ReadAloudClip } from "@t3tools/client-runtime/read-aloud";

/** The part of an expo-audio player that playback uses (a fake in tests). */
export interface ClipPlayer {
  readonly playing: boolean;
  play(): void;
  pause(): void;
  replace(source: { uri: string }): void;
  seekTo(seconds: number): Promise<void>;
  setPlaybackRate(rate: number, quality?: "low" | "medium" | "high"): void;
  addListener(
    event: "playbackStatusUpdate",
    listener: (status: {
      readonly playing: boolean;
      readonly duration: number;
      readonly currentTime: number;
      readonly didJustFinish: boolean;
    }) => void,
  ): { remove(): void };
  remove(): void;
}

type Slot = {
  readonly player: ClipPlayer;
  /** The clip this player holds (or is loading). */
  id: string | null;
  loading: Promise<void> | null;
};

/**
 * Read-aloud playback on the phone: one voice at a time, by construction.
 *
 * Two players take turns so the next chunk is loaded while the current one
 * plays (no gap between chunks). Only one of them, the owner, may ever sound:
 * - Loading pauses a player before and after replacing its clip. A player
 *   that finished a clip still "wants" to play, and expo-audio's replace()
 *   then starts the new clip as soon as it is prepared: that is how a
 *   preloaded chunk used to start two seconds into the one playing.
 * - A watchdog on every player pauses any player that reports playing while
 *   it is not the owner.
 * - A clip becomes the owner only once the previous one ended or was stopped;
 *   a play that was replaced or stopped while its clip loaded never starts.
 * Gaps are avoided by loading ahead (`next`, `preload`), never by starting early.
 */
export function createReadAloudAudio(deps: {
  readonly createPlayer: () => ClipPlayer;
  /** Writes a base64 WAV clip somewhere the player can read; returns its URI. */
  readonly writeClip: (audio: string) => Promise<string>;
  /** Readies the audio session before playing. */
  readonly prepare: () => Promise<void>;
}): ReadAloudAudio & { release(): void } {
  let slots: [Slot, Slot] | null = null;
  let owner: Slot | null = null;
  let generation = 0;
  let rejectClip: ((error: Error) => void) | null = null;
  let releaseClip: (() => void) | null = null;

  const newSlot = (): Slot => {
    const slot: Slot = { player: deps.createPlayer(), id: null, loading: null };
    slot.player.addListener("playbackStatusUpdate", (status) => {
      if (status.playing && slot !== owner) slot.player.pause();
    });
    return slot;
  };

  const silenceOthers = () => {
    for (const slot of slots ?? []) {
      if (slot !== owner) slot.player.pause();
    }
  };

  const slotPair = async (): Promise<[Slot, Slot]> => {
    await deps.prepare();
    slots ??= [newSlot(), newSlot()];
    return slots;
  };

  /** Puts a clip in a player without letting it start. */
  const load = (slot: Slot, clip: ReadAloudClip): Promise<void> => {
    if (slot.id === clip.id) return slot.loading ?? Promise.resolve();
    slot.player.pause();
    slot.id = clip.id;
    const loading = (async () => {
      const uri = await deps.writeClip(clip.audio);
      if (slot.id !== clip.id) return; // replaced by another clip meanwhile
      slot.player.pause();
      slot.player.replace({ uri });
      slot.player.pause();
    })();
    slot.loading = loading;
    loading
      .catch(() => {
        if (slot.id === clip.id) slot.id = null;
      })
      .finally(() => {
        if (slot.loading === loading) slot.loading = null;
      });
    return loading;
  };

  return {
    play: async (clip, { rate, startFraction, next, onProgress }) => {
      const mine = ++generation;
      rejectClip?.(new Error("replaced"));
      releaseClip?.();
      const previous = owner;
      owner = null;
      silenceOthers();
      const pair = await slotPair();
      const slot =
        pair.find((candidate) => candidate.id === clip.id) ??
        pair.find((candidate) => candidate !== previous) ??
        pair[0];
      // The same text gets the same clip from the server (voice mode's cue every
      // turn), and a player holding it may still sit at its end.
      const reused = slot.id === clip.id && slot.loading === null;
      await load(slot, clip);
      if (mine !== generation) throw new Error("replaced");
      const { player } = slot;
      if (reused && !startFraction) await player.seekTo(0);
      if (mine !== generation) throw new Error("replaced");
      owner = slot;
      silenceOthers();
      await new Promise<void>((resolve, reject) => {
        let seeked = !startFraction;
        const subscription = player.addListener("playbackStatusUpdate", (status) => {
          if (owner !== slot) return;
          if (status.duration > 0) {
            if (!seeked) {
              seeked = true;
              void player.seekTo(status.duration * (startFraction ?? 0));
            }
            onProgress?.(status.currentTime / status.duration);
          }
          if (status.didJustFinish) {
            releaseClip?.();
            resolve();
          }
        });
        releaseClip = () => {
          subscription.remove();
          releaseClip = null;
          rejectClip = null;
        };
        rejectClip = reject;
        player.setPlaybackRate(rate, "high");
        player.play();
        if (next) {
          const other = pair.find((candidate) => candidate !== slot);
          if (other) void load(other, next).catch(() => undefined);
        }
      });
    },
    pause: () => {
      owner?.player.pause();
      silenceOthers();
    },
    resume: () => owner?.player.play(),
    preload: (clip) => {
      // The next chunk, the moment it arrives: it then follows without a gap.
      const other = slots?.find((candidate) => candidate !== owner);
      if (other) void load(other, clip).catch(() => undefined);
    },
    stop: () => {
      generation++;
      owner?.player.pause();
      owner = null;
      silenceOthers();
      const reject = rejectClip;
      releaseClip?.();
      reject?.(new Error("stopped"));
    },
    /**
     * Frees the players. Each one carries a media session that answers the
     * earbud button, so voice mode drops them while you talk, and its own
     * session gets the tap. The next clip creates them again.
     */
    release: () => {
      if (owner && rejectClip) return;
      for (const slot of slots ?? []) slot.player.remove();
      slots = null;
      owner = null;
    },
  };
}
