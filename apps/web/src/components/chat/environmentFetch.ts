import type { EnvironmentId } from "@t3tools/contracts";
import { environmentFetchAuthorization } from "@t3tools/client-runtime/state/environmentHttpAuth";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";

type PreparedConnection = NonNullable<ReturnType<typeof readPreparedConnection>>;

/** A renewed DPoP token and a proof for one request; only the connection runtime can make them. */
function signedEnvironmentRequest(
  connection: PreparedConnection,
  path: string,
  rejectedAccessToken: string | undefined,
) {
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        environmentFetchAuthorization({
          prepared: connection,
          method: "POST",
          path,
          ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
        }).pipe(Effect.provide(context)),
      ),
    ),
  );
}

/**
 * POSTs JSON to one of the environment's own HTTP routes, with the connection's
 * credential (the desktop renderer is not same-origin with its server).
 * DPoP-bound connections (direct pairing since v0.1.11, T3 Connect) sign a
 * proof per request and renew the token once when the server refuses it.
 */
export async function environmentFetch(
  environmentId: EnvironmentId,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const connection = readPreparedConnection(environmentId);
  const signal = AbortSignal.timeout(timeoutMs);
  const payload = JSON.stringify(body);
  if (connection?.httpAuthorization?._tag === "Dpop") {
    let rejectedAccessToken: string | undefined;
    for (;;) {
      const auth = await signedEnvironmentRequest(connection, path, rejectedAccessToken);
      const response = await fetch(auth.url, {
        signal,
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          ...(auth.headers.authorization ? { Authorization: auth.headers.authorization } : {}),
          ...(auth.headers.dpop ? { DPoP: auth.headers.dpop } : {}),
        },
        body: payload,
      });
      if (response.status === 401 && auth.accessToken && rejectedAccessToken === undefined) {
        rejectedAccessToken = auth.accessToken;
        continue;
      }
      return response;
    }
  }
  const authorization = connection?.httpAuthorization ?? null;
  const sameOrigin =
    !connection || new URL(connection.httpBaseUrl).origin === window.location.origin;
  return fetch(sameOrigin ? path : new URL(path, connection.httpBaseUrl), {
    signal,
    method: "POST",
    credentials: authorization ? "omit" : sameOrigin ? "same-origin" : "include",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
    },
    body: payload,
  });
}
