import { useEffect } from "react";
import Constants from "expo-constants";
import { fetch } from "expo/fetch";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AppState, Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";

import { loadAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { requestAgentNotificationPermission } from "./notificationPermissions";

/**
 * Fork: native push without T3's hosted relay. The APK is built with the
 * fork's own Firebase project (google-services.json from CI), and the app
 * registers its FCM token with every environment it is paired with
 * (`POST /api/push/devices`, apps/server/src/erikPush.ts). Agents' phone
 * notifications then arrive as `t3_kind: "erik_notify"` data pushes that
 * AgentNotifications.kt renders, also when the app is closed.
 */
const RETRY_MS = 30_000;

async function registerWith(environmentId: EnvironmentId, body: object): Promise<boolean> {
  const connection = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const authorization = connection?.httpAuthorization ?? null;
  // Relay-only (DPoP) connections have no direct route to the server.
  if (!connection || authorization?._tag === "Dpop") return false;
  const response = await fetch(new URL("/api/push/devices", connection.httpBaseUrl).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  // Servers without the fork's push routes answer 404: nothing to retry.
  return response.ok || response.status === 404;
}

/** The device's push token, or null when not allowed or without Firebase in this build. */
async function readPushToken(): Promise<string | null> {
  try {
    const permission = await Effect.runPromise(requestAgentNotificationPermission);
    if (permission.type !== "granted") return null;
    return (await Notifications.getDevicePushTokenAsync()).data as string;
  } catch (error) {
    // No Firebase in this build (no google-services.json): nothing to register.
    console.warn("[erik-push] registration failed", error);
    return null;
  }
}

export function useErikPushRegistration(): void {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentIds = Object.keys(savedConnectionsById).sort().join(",");

  useEffect(() => {
    if (Platform.OS !== "android" || environmentIds === "") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let token: string | null = null;
    const pending = new Set(environmentIds.split(",") as EnvironmentId[]);
    const appId = Constants.expoConfig?.android?.package ?? "";

    const attempt = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (token === null) token = await readPushToken();
      if (token === null) return;
      let deviceId: Awaited<ReturnType<typeof loadAgentAwarenessDeviceId>>;
      try {
        deviceId = await loadAgentAwarenessDeviceId();
      } catch (error) {
        console.warn("[erik-push] registration failed", error);
        return;
      }
      const body = { token, deviceId, appId, label: "Android" };
      for (const environmentId of pending) {
        if (cancelled) return;
        const done = await registerWith(environmentId, body).catch(() => false);
        if (done) pending.delete(environmentId);
      }
      if (!cancelled && pending.size > 0) timer = setTimeout(() => void attempt(), RETRY_MS);
    };

    void attempt();
    const tokens = Notifications.addPushTokenListener((next) => {
      token = next.data as string;
      for (const id of environmentIds.split(",")) pending.add(id as EnvironmentId);
      void attempt();
    });
    // Re-register on every return to the app: cheap, and it heals a server
    // that lost its devices file.
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      for (const id of environmentIds.split(",")) pending.add(id as EnvironmentId);
      void attempt();
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      tokens.remove();
      appState.remove();
    };
  }, [environmentIds]);
}
