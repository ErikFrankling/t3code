import { describeInputDevice, type InputSource, type InputSourceMethod } from "@t3tools/contracts";

import { APP_VERSION } from "./branding";
import { clientPresentationMetadata } from "./connection/clientMetadata";
import { isHostedStaticApp } from "./hostedPairing";
import { usePrimaryEnvironment } from "./state/environments";
import { voiceMode } from "./components/chat/VoiceMode";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The machine is only known when the client runs next to its primary server: the
 * desktop app, or a browser pointed at localhost. A browser on another machine
 * cannot say which one it is on.
 */
export function inputDeviceName(primaryEnvironmentLabel: string | undefined): string {
  const metadata = clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: isHostedStaticApp(),
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
  const desktop = metadata.surface === "desktop";
  return describeInputDevice({
    surface: desktop ? "desktop" : "web",
    ...(metadata.deviceType === "mobile"
      ? { handheld: "phone" as const }
      : metadata.deviceType === "tablet"
        ? { handheld: "tablet" as const }
        : {}),
    hostLabel:
      desktop || LOOPBACK_HOSTS.has(window.location.hostname) ? primaryEnvironmentLabel : undefined,
  });
}

export function useInputDevice(): string {
  return inputDeviceName(usePrimaryEnvironment()?.label);
}

/** Dictation is voice mode when the full-screen loop is open at the moment it is sent. */
export function inputSourceFor(input: {
  readonly device: string;
  readonly dictated: boolean;
  readonly via?: string;
}): InputSource {
  const method: InputSourceMethod = !input.dictated
    ? "typed"
    : voiceMode.isOpen()
      ? "voice mode"
      : "dictation";
  return {
    device: input.device,
    ...(input.via === undefined ? {} : { via: input.via }),
    method,
  };
}
