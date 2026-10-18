import { AuthOrchestrationOperateScope, ReadAloudRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "./http.ts";
import { readAloud } from "./readAloud.ts";

const decodeReadAloudRequest = Schema.decodeUnknownEffect(ReadAloudRequest);

/** Starts or polls a read-aloud job (`readAloud.ts`); clients poll until it completes. */
export const layerReadAloudRoute = HttpRouter.add(
  "POST",
  "/api/read-aloud",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* decodeReadAloudRequest(yield* request.json);
    if (!body.id && !body.text) {
      return HttpServerResponse.text("Nothing to read.", { status: 400 });
    }
    const state = readAloud(body);
    if (!state) return HttpServerResponse.text("Unknown read-aloud job.", { status: 404 });
    return HttpServerResponse.jsonUnsafe(state);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.tapError((cause) => Effect.logError("read_aloud.request_failed", { cause })),
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text("The read-aloud request is invalid.", { status: 400 }),
      ),
    ),
  ),
);
