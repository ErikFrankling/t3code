import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
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
import { voicePresence } from "./voicePresence.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const BeatRequest = Schema.Struct({
  deviceId: Id,
  threadId: Id,
  on: Schema.Boolean,
  done: Schema.optional(
    Schema.Array(Schema.Struct({ id: Id, status: Schema.Literals(["played", "skipped"]) })),
  ),
  waitMs: Schema.optional(Schema.Number),
});

const SayRequest = Schema.Struct({
  id: Id,
  threadId: Id,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  /** The words the message was made from (the speak tool's text), for the chat's highlight. */
  source: Schema.optional(Schema.String.check(Schema.isMaxLength(8000))),
});

const decodeBeat = Schema.decodeUnknownEffect(BeatRequest);
const decodeSay = Schema.decodeUnknownEffect(SayRequest);

const authErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const invalid = () =>
  Effect.succeed(
    HttpServerResponse.text("The voice presence request is invalid.", { status: 400 }),
  );

/** The phone in voice mode: report played messages, wait for the next ones (`voicePresence.ts`). */
const beatRoute = HttpRouter.add(
  "POST",
  "/api/voice-presence",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* decodeBeat(yield* request.json);
    const utterances = yield* Effect.promise(() => voicePresence.beat(body));
    return HttpServerResponse.jsonUnsafe({ utterances });
  }).pipe(
    Effect.catchTags(authErrors),
    Effect.tapError((cause) => Effect.logError("voice_presence.beat_failed", { cause })),
    Effect.catch(invalid),
  ),
);

/** For the speak daemon: is a phone in voice mode, and on which thread. */
const presenceRoute = HttpRouter.add(
  "GET",
  "/api/voice-presence",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return HttpServerResponse.jsonUnsafe(voicePresence.presence());
  }).pipe(Effect.catchTags(authErrors), Effect.catch(invalid)),
);

/** The speak daemon hands a message to the phone; 409 when no phone is in voice mode there. */
const sayRoute = HttpRouter.add(
  "POST",
  "/api/voice-presence/say",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* decodeSay(yield* request.json);
    const status = voicePresence.say(body);
    if (!status) {
      return HttpServerResponse.jsonUnsafe({ id: body.id, status: "absent" }, { status: 409 });
    }
    yield* Effect.logInfo("voice_presence.queued", { id: body.id, threadId: body.threadId });
    return HttpServerResponse.jsonUnsafe({ id: body.id, status });
  }).pipe(
    Effect.catchTags(authErrors),
    Effect.tapError((cause) => Effect.logError("voice_presence.say_failed", { cause })),
    Effect.catch(invalid),
  ),
);

/** `?id=`: what became of a message handed to the phone. */
const statusRoute = HttpRouter.add(
  "GET",
  "/api/voice-presence/say",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = new URL(request.url, "http://localhost").searchParams.get("id");
    const status = id ? voicePresence.status(id) : null;
    if (!status) return HttpServerResponse.text("Unknown message.", { status: 404 });
    return HttpServerResponse.jsonUnsafe({ id, status });
  }).pipe(Effect.catchTags(authErrors), Effect.catch(invalid)),
);

export const layerVoicePresenceRoutes = Layer.mergeAll(
  beatRoute,
  presenceRoute,
  sayRoute,
  statusRoute,
);
