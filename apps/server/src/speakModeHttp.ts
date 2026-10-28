import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SpeakModeRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "./http.ts";
import { readSpeakMode, writeSpeakMode } from "./speakMode.ts";

const decodeRequest = Schema.decodeUnknownEffect(SpeakModeRequest);

const authErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const unavailable = () =>
  HttpServerResponse.text("The speak daemon is not running on this machine.", { status: 503 });

/** Erik's voice mode: read it. */
const readRoute = HttpRouter.add(
  "GET",
  "/api/speak-mode",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const state = yield* Effect.promise(() => readSpeakMode());
    return state ? HttpServerResponse.jsonUnsafe(state) : unavailable();
  }).pipe(Effect.catchTags(authErrors)),
);

/** Sets the mode with `{ mode }`; a body without `mode` only reads it (clients that can only POST). */
const writeRoute = HttpRouter.add(
  "POST",
  "/api/speak-mode",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { mode } = yield* decodeRequest(yield* request.json);
    const state = yield* Effect.promise(() => (mode ? writeSpeakMode(mode) : readSpeakMode()));
    if (mode && state) yield* Effect.logInfo("speak_mode.set", { mode });
    return state ? HttpServerResponse.jsonUnsafe(state) : unavailable();
  }).pipe(
    Effect.catchTags(authErrors),
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("The voice mode is invalid.", { status: 400 }),
    ),
  ),
);

export const layerSpeakModeRoutes = Layer.mergeAll(readRoute, writeRoute);
