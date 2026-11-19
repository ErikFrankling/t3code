import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentFetchAuthorization } from "@t3tools/client-runtime/state/environmentHttpAuth";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";

/** Fork: a renewed DPoP token and a proof for one request to the fork's routes. */
export async function signedEnvironmentRequest(
  connection: PreparedConnection,
  method: "GET" | "POST",
  path: string,
  rejectedAccessToken: string | undefined,
) {
  const auth = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        environmentFetchAuthorization({
          prepared: connection,
          method,
          path,
          ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
        }).pipe(Effect.provide(context)),
      ),
    ),
  );
  const headers: Record<string, string> = {};
  if (auth.headers.authorization) headers.Authorization = auth.headers.authorization;
  if (auth.headers.dpop) headers.DPoP = auth.headers.dpop;
  return { url: auth.url, headers, accessToken: auth.accessToken };
}
