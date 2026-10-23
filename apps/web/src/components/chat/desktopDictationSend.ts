import { useEffect, useEffectEvent } from "react";

// Every mounted recorder in this window, in the order it started recording.
// The window reports one boolean, so several composers must not overwrite
// each other's state.
const recorders = new Map<symbol, () => void>();
let reported = false;
let unsubscribe: (() => void) | null = null;

function sync() {
  const bridge = window.desktopBridge?.dictation;
  if (!bridge) return;
  const recording = recorders.size > 0;
  if (recording && unsubscribe === null) {
    unsubscribe = bridge.onSendRequest(() => [...recorders.values()].at(-1)?.());
  }
  if (recording === reported) return;
  reported = recording;
  void bridge.reportRecording(recording);
}

/**
 * Lets a global hotkey send this window's dictation (`t3 app dictation --send`,
 * bound by Erik's Hyprland to plain Enter while something records). Reports
 * whether the microphone is open, and runs `send` when the desktop app picks
 * this window. Does nothing in a browser or on mobile (no desktop bridge).
 */
export function useDesktopDictationSend(recording: boolean, send: () => void) {
  const onSend = useEffectEvent(send);

  useEffect(() => {
    if (!recording || !window.desktopBridge?.dictation) return;
    const key = Symbol("dictation");
    recorders.set(key, () => onSend());
    sync();
    // Paused, sent or unmounted: this recorder no longer records.
    return () => {
      recorders.delete(key);
      sync();
    };
  }, [recording]);
}
