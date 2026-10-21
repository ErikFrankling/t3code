// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Plain Node calls to Google's FCM API and a small JSON file, like readAloud.ts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Native push to the fork's Android app through Firebase Cloud Messaging.
 *
 * The app registers its FCM token here (`POST /api/push/devices`), over the
 * same connection it already uses for everything else, so only a device that
 * can reach and authenticate to this server can receive pushes. Agents' phone
 * notifications (`notify-erik`, the Executor `notify` app) are sent through
 * `POST /api/push/send`; the app renders them natively
 * (`t3_kind: "erik_notify"`, AgentNotifications.kt), so a tap opens the
 * thread even when the app was not running.
 *
 * Needs `T3CODE_FCM_SERVICE_ACCOUNT_FILE`: a Google service-account key of
 * the Firebase project the APK was built with (google-services.json).
 */
export type PushClass = "urgent" | "high" | "normal" | "low" | "code";

export interface PushDevice {
  readonly deviceId: string;
  readonly token: string;
  readonly appId: string;
  readonly label: string;
  readonly registeredAt: string;
}

export interface PushMessage {
  readonly title: string;
  readonly message: string;
  readonly class: PushClass;
  /** App route, `/threads/<environmentId>/<threadId>`. */
  readonly path?: string | undefined;
  /** http(s) link opened instead when there is no thread. */
  readonly url?: string | undefined;
  readonly code?: string | undefined;
  readonly id?: string | undefined;
}

export interface PushResult {
  readonly devices: number;
  readonly delivered: number;
  readonly errors: ReadonlyArray<string>;
}

const MAX_DEVICES = 8;
const devicesFile = (stateDir: string) => NodePath.join(stateDir, "push-devices.json");

export async function loadPushDevices(stateDir: string): Promise<PushDevice[]> {
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(devicesFile(stateDir), "utf8"));
    return Array.isArray(parsed) ? (parsed as PushDevice[]) : [];
  } catch {
    return [];
  }
}

async function savePushDevices(stateDir: string, devices: PushDevice[]): Promise<void> {
  const file = devicesFile(stateDir);
  const temp = `${file}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temp, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temp, file);
}

let queue: Promise<unknown> = Promise.resolve();
/** Serializes read-modify-write of the devices file. */
function locked<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export function registerPushDevice(
  stateDir: string,
  device: Omit<PushDevice, "registeredAt">,
): Promise<number> {
  return locked(async () => {
    const others = (await loadPushDevices(stateDir)).filter(
      (d) => d.deviceId !== device.deviceId && d.token !== device.token,
    );
    const devices = [...others, { ...device, registeredAt: new Date().toISOString() }].slice(
      -MAX_DEVICES,
    );
    await savePushDevices(stateDir, devices);
    return devices.length;
  });
}

function removePushTokens(stateDir: string, tokens: ReadonlySet<string>): Promise<void> {
  return locked(async () => {
    const devices = await loadPushDevices(stateDir);
    await savePushDevices(
      stateDir,
      devices.filter((d) => !tokens.has(d.token)),
    );
  });
}

interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

let cachedToken: { value: string; expiresAt: number; file: string } | null = null;

async function serviceAccount(): Promise<{ account: ServiceAccount; file: string } | null> {
  const file = process.env.T3CODE_FCM_SERVICE_ACCOUNT_FILE;
  if (!file) return null;
  const account = JSON.parse(await NodeFSP.readFile(file, "utf8")) as ServiceAccount;
  return { account, file };
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

async function accessToken(account: ServiceAccount, file: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.file === file && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    }),
  )}`;
  const signature = NodeCrypto.sign("RSA-SHA256", Buffer.from(unsigned), account.private_key);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: now + body.expires_in * 1000, file };
  return body.access_token;
}

/** Codes are useless after a few minutes; everything else may wait a day for the phone. */
const TTL: Record<PushClass, string> = {
  urgent: "86400s",
  high: "86400s",
  normal: "86400s",
  low: "86400s",
  code: "600s",
};

export function fcmPayload(token: string, message: PushMessage, sentAt = Date.now()) {
  const data: Record<string, string> = {
    t3_kind: "erik_notify",
    id: message.id ?? NodeCrypto.randomUUID(),
    title: message.title,
    body: message.message,
    class: message.class,
    sent_at: String(sentAt),
  };
  if (message.path) data.path = message.path;
  if (message.url) data.url = message.url;
  if (message.code) data.code = message.code;
  return {
    message: {
      token,
      // Data only: the app renders it natively (channel, Copy button, tap
      // target), also when the process was not running.
      data,
      android: {
        priority: message.class === "low" ? "NORMAL" : "HIGH",
        ttl: TTL[message.class],
      },
    },
  };
}

export async function sendPush(stateDir: string, message: PushMessage): Promise<PushResult> {
  const devices = await loadPushDevices(stateDir);
  const credentials = await serviceAccount();
  if (!credentials) {
    return { devices: devices.length, delivered: 0, errors: ["FCM is not configured"] };
  }
  if (devices.length === 0) return { devices: 0, delivered: 0, errors: ["no registered device"] };
  const { account, file } = credentials;
  const token = await accessToken(account, file);
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`;
  const sentAt = Date.now();
  const stale = new Set<string>();
  const errors: string[] = [];
  let delivered = 0;
  await Promise.all(
    devices.map(async (device) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(fcmPayload(device.token, message, sentAt)),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          delivered += 1;
          return;
        }
        const text = await response.text();
        // The app was uninstalled or its token rotated: forget the device.
        if (
          response.status === 404 ||
          text.includes("UNREGISTERED") ||
          text.includes("not a valid FCM registration token")
        ) {
          stale.add(device.token);
        }
        errors.push(`${device.label}: FCM ${response.status} ${text.slice(0, 300)}`);
      } catch (cause) {
        errors.push(`${device.label}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }),
  );
  if (stale.size > 0) await removePushTokens(stateDir, stale);
  return { devices: devices.length, delivered, errors };
}
