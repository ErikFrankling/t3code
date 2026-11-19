import { fetch } from "expo/fetch";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

type Init = {
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array<ArrayBuffer>;
};

/**
 * Fork: a request to the fork's own routes with the connection's credentials.
 * DPoP-bound connections (direct pairing since v0.1.11, T3 Connect) sign a proof
 * per request and renew the token once when the server refuses it.
 */
export async function environmentFetch(
  connection: PreparedConnection,
  path: string,
  init: Init = {},
): Promise<Response> {
  const method = init.method ?? "POST";
  const send = (url: string, auth: Record<string, string>) =>
    fetch(url, {
      method,
      headers: { ...init.headers, ...auth },
      ...(init.body === undefined ? {} : { body: init.body }),
    }) as unknown as Promise<Response>;
  const authorization = connection.httpAuthorization;
  if (authorization?._tag !== "Dpop") {
    const url = new URL(path, connection.httpBaseUrl).toString();
    return send(url, authorization ? { Authorization: `Bearer ${authorization.token}` } : {});
  }
  // Loaded only here: the connection runtime pulls in every native module.
  const { signedEnvironmentRequest } = await import("./environmentFetchDpop");
  let rejectedAccessToken: string | undefined;
  for (;;) {
    const auth = await signedEnvironmentRequest(connection, method, path, rejectedAccessToken);
    const response = await send(auth.url, auth.headers);
    if (response.status === 401 && auth.accessToken && rejectedAccessToken === undefined) {
      rejectedAccessToken = auth.accessToken;
      continue;
    }
    return response;
  }
}
