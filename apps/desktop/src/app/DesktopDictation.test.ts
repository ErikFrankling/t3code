// @effect-diagnostics nodeBuiltinImport:off -- Runs a real hook script to prove the spawn arguments.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { once: vi.fn() }, webContents: { fromId: vi.fn() } }));

import {
  makeDictationHookRunner,
  makeDictationTracker,
  spawnDictationHook,
  type DictationHookState,
  type DictationRenderer,
} from "./DesktopDictation.ts";

function renderer(id: number) {
  const state = { destroyed: false, sends: 0 };
  const value: DictationRenderer = {
    id,
    send: () => {
      state.sends += 1;
    },
    isDestroyed: () => state.destroyed,
  };
  return { value, state };
}

function tracker() {
  const changes: DictationHookState[] = [];
  return { changes, tracker: makeDictationTracker({ onChange: (state) => changes.push(state) }) };
}

describe("dictation tracker", () => {
  it("runs the hook only when the aggregate changes", () => {
    const { changes, tracker: dictation } = tracker();
    const main = renderer(1);
    const reply = renderer(2);
    dictation.report(main.value, false);
    dictation.report(main.value, true);
    dictation.report(main.value, true);
    dictation.report(reply.value, true);
    dictation.report(main.value, false);
    expect(changes).toEqual(["recording"]);
    dictation.report(reply.value, false);
    expect(changes).toEqual(["recording", "stopped"]);
    expect(dictation.recording()).toBe(false);
  });

  it("counts a destroyed, crashed or navigated window as stopped", () => {
    const { changes, tracker: dictation } = tracker();
    const main = renderer(1);
    dictation.report(main.value, true);
    dictation.gone(1);
    expect(changes).toEqual(["recording", "stopped"]);

    const reply = renderer(2);
    dictation.report(reply.value, true);
    reply.state.destroyed = true;
    // Noticed even without a "destroyed" event.
    expect(dictation.recording()).toBe(false);
    expect(dictation.send()).toBe(false);
    expect(changes).toEqual(["recording", "stopped", "recording", "stopped"]);
  });

  it("sends to the most recently started recorder", () => {
    const { tracker: dictation } = tracker();
    const main = renderer(1);
    const reply = renderer(2);
    dictation.report(main.value, true);
    dictation.report(reply.value, true);
    // Re-reporting does not make the older one the newest.
    dictation.report(main.value, true);
    expect(dictation.send()).toBe(true);
    expect(reply.state.sends).toBe(1);
    expect(main.state.sends).toBe(0);

    dictation.report(reply.value, false);
    expect(dictation.send()).toBe(true);
    expect(main.state.sends).toBe(1);
  });

  it("refuses a send when nothing records", () => {
    const { tracker: dictation } = tracker();
    const main = renderer(1);
    expect(dictation.send()).toBe(false);
    dictation.report(main.value, true);
    dictation.report(main.value, false);
    expect(dictation.send()).toBe(false);
    expect(main.state.sends).toBe(0);
  });

  it("reports stopped on quit only when something recorded", () => {
    const { changes, tracker: dictation } = tracker();
    dictation.stopAll();
    expect(changes).toEqual([]);
    dictation.report(renderer(1).value, true);
    dictation.stopAll();
    dictation.stopAll();
    expect(changes).toEqual(["recording", "stopped"]);
  });
});

describe("dictation hook runner", () => {
  it("runs the hook with the state as its only argument, in order", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-hook-"));
    try {
      const log = NodePath.join(root, "log");
      const script = NodePath.join(root, "hook.sh");
      // Slow first run: the second state must wait for it, not overtake it.
      await NodeFSP.writeFile(
        script,
        `#!/bin/sh\n[ "$1" = recording ] && sleep 0.2\nprintf '%s|%s\\n' "$#" "$1" >> "${log}"\n`,
        { mode: 0o755 },
      );
      const exited: Promise<unknown>[] = [];
      const runner = makeDictationHookRunner({
        command: script,
        spawn: (command, state) => {
          const child = spawnDictationHook(command, state);
          exited.push(NodeEvents.EventEmitter.once(child, "exit"));
          return child;
        },
        warn: () => undefined,
      });
      runner.run("recording");
      runner.run("stopped");
      await vi.waitFor(async () => {
        expect(await NodeFSP.readFile(log, "utf8").catch(() => "")).toBe(
          "1|recording\n1|stopped\n",
        );
      });
      await Promise.all(exited);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps only the latest pending state", () => {
    const states: DictationHookState[] = [];
    const children: Array<NodeEvents.EventEmitter & { unref: () => void }> = [];
    const runner = makeDictationHookRunner({
      command: "/hook",
      spawn: (_command, state) => {
        states.push(state);
        const child = Object.assign(new NodeEvents.EventEmitter(), { unref: () => undefined });
        children.push(child);
        return child as never;
      },
      warn: () => undefined,
    });
    runner.run("recording");
    runner.run("stopped");
    runner.run("recording");
    runner.run("stopped");
    expect(states).toEqual(["recording"]);
    children[0]!.emit("exit", 0);
    expect(states).toEqual(["recording", "stopped"]);
  });

  it("never throws when the hook is missing or fails, and does nothing without one", async () => {
    const warn = vi.fn();
    const missing = makeDictationHookRunner({
      command: "/nonexistent/t3-dictation-hook",
      spawn: spawnDictationHook,
      warn,
    });
    missing.run("recording");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    // The failed run released the queue.
    missing.run("stopped");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));

    const throwing = makeDictationHookRunner({
      command: "/hook",
      spawn: () => {
        throw new Error("spawn failed");
      },
      warn,
    });
    expect(() => throwing.run("recording")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);

    const spawn = vi.fn();
    const none = makeDictationHookRunner({ command: undefined, spawn, warn });
    none.run("recording");
    none.runNow("stopped");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("lets a hung hook hold the next one back only until the timeout", async () => {
    const states: DictationHookState[] = [];
    const runner = makeDictationHookRunner({
      command: "/hook",
      spawn: (_command, state) => {
        states.push(state);
        return Object.assign(new NodeEvents.EventEmitter(), { unref: () => undefined }) as never;
      },
      warn: () => undefined,
      timeoutMs: 20,
    });
    runner.run("recording");
    runner.run("stopped");
    expect(states).toEqual(["recording"]);
    await vi.waitFor(() => expect(states).toEqual(["recording", "stopped"]));
  });
});
