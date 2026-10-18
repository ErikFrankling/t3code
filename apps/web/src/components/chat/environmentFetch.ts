import type { EnvironmentId } from "@t3tools/contracts";

import { readPreparedConnection } from "../../state/session";

/**
 * POSTs JSON to one of the environment's own HTTP routes. The web client is
 * same-origin with its server, but the desktop renderer is served from
 * t3code://app, so the request has to go to the environment's HTTP origin
 * with its credential.
 */
export async function environmentFetch(
  environmentId: EnvironmentId,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const connection = readPreparedConnection(environmentId);
  const authorization = connection?.httpAuthorization ?? null;
  if (authorization?._tag === "Dpop") throw new Error("Not available over a relay connection.");
  const sameOrigin =
    !connection || new URL(connection.httpBaseUrl).origin === window.location.origin;
  return fetch(sameOrigin ? path : new URL(path, connection.httpBaseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
    method: "POST",
    credentials: authorization ? "omit" : sameOrigin ? "same-origin" : "include",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
