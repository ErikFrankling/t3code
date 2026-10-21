// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Temp files and a stubbed fetch stand in for the state dir and Google.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fcmPayload, loadPushDevices, registerPushDevice, sendPush } from "./erikPush.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "erik-push-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.T3CODE_FCM_SERVICE_ACCOUNT_FILE;
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const device = (deviceId: string, token: string) => ({
  deviceId,
  token,
  appId: "com.t3tools.t3code.preview",
  label: "Android",
});

describe("registerPushDevice", () => {
  it("replaces a device's earlier token and a token another device had", async () => {
    await registerPushDevice(dir, device("a", "t1"));
    await registerPushDevice(dir, device("b", "t2"));
    await registerPushDevice(dir, device("a", "t3"));
    await registerPushDevice(dir, device("c", "t2"));
    const devices = await loadPushDevices(dir);
    expect(devices.map((d) => [d.deviceId, d.token])).toEqual([
      ["a", "t3"],
      ["c", "t2"],
    ]);
  });

  it("keeps the newest eight", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => registerPushDevice(dir, device(`d${i}`, `t${i}`))),
    );
    const devices = await loadPushDevices(dir);
    expect(devices).toHaveLength(8);
    expect(devices.at(-1)?.deviceId).toBe("d9");
  });
});

describe("fcmPayload", () => {
  it("sends a data-only message the app renders itself", () => {
    const payload = fcmPayload(
      "tok",
      {
        title: "Code: 123",
        message: "Login",
        class: "code",
        code: "123",
        path: "/threads/env/thread",
        id: "n1",
      },
      42,
    );
    expect(payload).toEqual({
      message: {
        token: "tok",
        data: {
          t3_kind: "erik_notify",
          id: "n1",
          title: "Code: 123",
          body: "Login",
          class: "code",
          sent_at: "42",
          path: "/threads/env/thread",
          code: "123",
        },
        android: { priority: "HIGH", ttl: "600s" },
      },
    });
    expect(fcmPayload("tok", { title: "t", message: "m", class: "low" }).message.android).toEqual({
      priority: "NORMAL",
      ttl: "86400s",
    });
  });
});

describe("sendPush", () => {
  it("reports when FCM is not configured", async () => {
    await registerPushDevice(dir, device("a", "t1"));
    expect(await sendPush(dir, { title: "t", message: "m", class: "normal" })).toEqual({
      devices: 1,
      delivered: 0,
      errors: ["FCM is not configured"],
    });
  });

  it("signs in as the service account, sends to every device and forgets dead tokens", async () => {
    const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = NodePath.join(dir, "sa.json");
    await NodeFSP.writeFile(
      keyFile,
      JSON.stringify({
        project_id: "proj",
        client_email: "sa@proj.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    );
    process.env.T3CODE_FCM_SERVICE_ACCOUNT_FILE = keyFile;
    await registerPushDevice(dir, device("a", "good"));
    await registerPushDevice(dir, device("b", "gone"));
    const sent: Array<{ url: string; body: string; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({
          url,
          body: String(init.body),
          auth: new Headers(init.headers).get("authorization"),
        });
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "at", expires_in: 3600 });
        }
        return String(init.body).includes('"gone"')
          ? new Response(
              '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
              {
                status: 404,
              },
            )
          : Response.json({ name: "projects/proj/messages/1" });
      }),
    );

    const result = await sendPush(dir, { title: "t", message: "m", class: "high" });

    expect(result.devices).toBe(2);
    expect(result.delivered).toBe(1);
    const assertion = new URLSearchParams(sent[0]!.body).get("assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "sa@proj.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    expect(sent.slice(1).map((s) => [s.url, s.auth])).toEqual([
      ["https://fcm.googleapis.com/v1/projects/proj/messages:send", "Bearer at"],
      ["https://fcm.googleapis.com/v1/projects/proj/messages:send", "Bearer at"],
    ]);
    expect((await loadPushDevices(dir)).map((d) => d.token)).toEqual(["good"]);
  });
});
