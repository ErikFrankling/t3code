import { ActivityEvent, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { recordActivity } from "./activityLog.ts";
import { authenticateRawRouteWithScope } from "./http.ts";

const decodeActivity = Schema.decodeUnknownEffect(ActivityEvent);

/** Clients report finished read-aloud plays, voice-mode spans and thread focus here. */
export const layerActivityLogRoute = HttpRouter.add(
  "POST",
  "/api/activity",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const event = yield* decodeActivity(yield* request.json);
    const recorded = yield* recordActivity(event);
    return recorded
      ? HttpServerResponse.jsonUnsafe({ recorded: true })
      : HttpServerResponse.text("The times are not valid.", { status: 400 });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.tapError((cause) => Effect.logError("activity_log.request_failed", { cause })),
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.text("The activity event is invalid.", { status: 400 })),
    ),
  ),
);
