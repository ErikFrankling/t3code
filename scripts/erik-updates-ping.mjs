#!/usr/bin/env node
// Fork-only: after a release is published, tell installed apps to check now
// instead of at their next 15-minute poll (docs/erik-updates.md). Sends a
// content-free, high-priority FCM data message to the `erik-updates` topic;
// t3-agent-notifications hands it to the self-updater, which downloads a newer
// APK and installs it if the app is not in use. Anyone with the APK's
// google-services.json can subscribe to the topic, so the message must never
// carry anything but this ping.
//
//   T3CODE_FCM_SERVICE_ACCOUNT_JSON='{...}' node scripts/erik-updates-ping.mjs
import * as Crypto from "node:crypto";

const account = JSON.parse(process.env.T3CODE_FCM_SERVICE_ACCOUNT_JSON ?? "null");
if (!account?.client_email || !account?.private_key || !account?.project_id) {
  console.error("T3CODE_FCM_SERVICE_ACCOUNT_JSON is missing or not a service account");
  process.exit(1);
}

const base64url = (input) => Buffer.from(input).toString("base64url");

async function accessToken() {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    }),
  )}`;
  const signature = Crypto.sign("RSA-SHA256", Buffer.from(unsigned), account.private_key);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`token request failed (${response.status}): ${await response.text()}`);
  return (await response.json()).access_token;
}

const response = await fetch(
  `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
  {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        topic: "erik-updates",
        data: { t3_kind: "erik_update" },
        // A later release's ping supersedes this one.
        android: { priority: "HIGH", ttl: "3600s" },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  },
);
if (!response.ok) {
  console.error(`FCM send failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}
console.log(`pinged erik-updates: ${(await response.json()).name}`);
