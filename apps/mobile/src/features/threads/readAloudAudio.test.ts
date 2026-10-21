import { ReadAloudPlayer } from "@t3tools/client-runtime/read-aloud";
import { describe, expect, it } from "vite-plus/test";

import { createReadAloudAudio, type ClipPlayer } from "./readAloudAudio";

/**
 * A player that behaves like expo-audio's on Android (ExoPlayer): play() sets
 * "play when ready", which stays set after a clip finishes, and replace()
 * prepares the new clip and starts it on its own if "play when ready" is set.
 * That is what made a preloaded chunk start while another one played.
 */
class FakePlayer implements ClipPlayer {
  static sounding = new Set<FakePlayer>();
  static mostAtOnce = 0;
  static heard: string[] = [];
  playing = false;
  playWhenReady = false;
  uri: string | null = null;
  ready = false;
  private listeners = new Set<
    (status: Parameters<Parameters<ClipPlayer["addListener"]>[1]>[0]) => void
  >();

  private emit(didJustFinish = false) {
    for (const listener of this.listeners) {
      listener({ playing: this.playing, duration: 1, currentTime: 0, didJustFinish });
    }
  }
  private sound(on: boolean) {
    this.playing = on;
    if (on) {
      FakePlayer.sounding.add(this);
      FakePlayer.heard.push(this.uri!);
    } else FakePlayer.sounding.delete(this);
    FakePlayer.mostAtOnce = Math.max(FakePlayer.mostAtOnce, FakePlayer.sounding.size);
    this.emit();
  }
  play() {
    this.playWhenReady = true;
    if (this.ready && !this.playing) this.sound(true);
  }
  pause() {
    this.playWhenReady = false;
    if (this.playing) this.sound(false);
  }
  replace(source: { uri: string }) {
    if (this.playing) this.sound(false);
    this.uri = source.uri;
    this.ready = false;
    queueMicrotask(() => {
      this.ready = true;
      if (this.playWhenReady) this.sound(true);
    });
  }
  async seekTo() {}
  setPlaybackRate() {}
  addListener(_event: "playbackStatusUpdate", listener: Parameters<ClipPlayer["addListener"]>[1]) {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }
  remove() {}
  /** The clip reaches its end; "play when ready" stays set, as in ExoPlayer. */
  finish() {
    FakePlayer.sounding.delete(this);
    this.playing = false;
    this.emit(true);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("read-aloud playback on the phone", () => {
  it("never lets two clips sound at once, however chunks arrive", async () => {
    FakePlayer.sounding.clear();
    FakePlayer.mostAtOnce = 0;
    FakePlayer.heard = [];
    const players: FakePlayer[] = [];
    const audio = createReadAloudAudio({
      createPlayer: () => {
        const player = new FakePlayer();
        players.push(player);
        return player;
      },
      writeClip: async (base64) => `clip:${base64}`,
      prepare: async () => {},
    });
    // Five chunks; each poll brings one more, so most arrive while one plays
    // (the case that made the preloaded player start on its own).
    let polls = 0;
    const chunks = ["A", "B", "C", "D", "E"];
    const player = new ReadAloudPlayer({
      pollMs: 1,
      audio,
      request: async () => {
        polls++;
        const count = Math.min(chunks.length, polls);
        return {
          id: "job",
          status: count === chunks.length ? "complete" : "working",
          voice: "small",
          error: "",
          sentences: chunks.map((audio, index) => ({
            text: `Sentence ${index}.`,
            ...(index < count ? { audio, span: 1 } : {}),
            ready: index < count,
          })),
        };
      },
    });
    player.start("key", "Text.");
    for (let step = 0; step < 200 && FakePlayer.heard.length < chunks.length; step++) {
      await tick();
      const playing = players.find((candidate) => candidate.playing);
      // Let each clip play a little while the next chunks arrive, then end it.
      if (playing && step % 7 === 6) playing.finish();
    }
    await tick();
    expect(FakePlayer.mostAtOnce).toBe(1);
    expect(FakePlayer.heard).toEqual(["clip:A", "clip:B", "clip:C", "clip:D", "clip:E"]);
    player.stop();
  });

  it("does not start a clip that was stopped while it loaded", async () => {
    FakePlayer.sounding.clear();
    FakePlayer.heard = [];
    let release: (() => void) | null = null;
    const audio = createReadAloudAudio({
      createPlayer: () => new FakePlayer(),
      writeClip: (base64) =>
        new Promise((resolve) => {
          release = () => resolve(`clip:${base64}`);
        }),
      prepare: async () => {},
    });
    const playing = audio.play({ id: "1", audio: "A" }, { rate: 1 }).catch(() => "stopped");
    await tick();
    audio.stop();
    release!();
    expect(await playing).toBe("stopped");
    await tick();
    expect(FakePlayer.heard).toEqual([]);
  });
});
