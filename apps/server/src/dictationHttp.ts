import {
  AuthOrchestrationOperateScope,
  DictationRequest,
  DictationState,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { DICTATION_AUDIO_MAX_BYTES, submitRecording } from "./dictationAudio.ts";
import { DictationDelivery, speechServiceUrl } from "./DictationDelivery.ts";
import * as ServerConfig from "./config.ts";
import { authenticateRawRouteWithScope } from "./http.ts";

const decodeDictationRequest = Schema.decodeUnknownEffect(DictationRequest);
const decodeDictationState = Schema.decodeUnknownEffect(Schema.fromJsonString(DictationState));

// The speech worker is loopback-only. Browser credentials terminate here and are
// never forwarded; ownership uses the authenticated subject, stable across sessions.
export const layerDictationRoute = Layer.unwrap(
  Effect.gen(function* () {
    const deliveries = yield* DictationDelivery;
    return HttpRouter.add(
      "POST",
      "/api/dictation",
      Effect.gen(function* () {
        const session = yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const client = yield* HttpClient.HttpClient;
        const body = yield* decodeDictationRequest(yield* request.json);
        const response = yield* client.post(speechServiceUrl(), {
          body: HttpBody.jsonUnsafe(body),
          headers: { "X-STT-Owner": session.subject },
        });
        const raw = yield* response.text;
        if (response.status !== 200) {
          yield* Effect.logWarning("dictation.speech_request_failed", {
            recordingId: body.id,
            action: body.action,
            status: response.status,
          });
          return HttpServerResponse.text(raw, { status: response.status });
        }
        const state = yield* decodeDictationState(raw);
        const delivery = deliveries.get(session.subject, state.id);
        return HttpServerResponse.jsonUnsafe({
          ...state,
          ...(delivery ? { delivery: delivery.status, deliveryError: delivery.error } : {}),
        });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
        Effect.tapError((cause) => Effect.logError("dictation.request_failed", { cause })),
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text(
              "The local speech service is unavailable or the request is invalid.",
              { status: 502 },
            ),
          ),
        ),
      ),
    );
  }),
);

const RECORDING_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Compressed recordings from the Android app, streamed or whole (see `dictationAudio.ts`). */
export const layerDictationAudioRoute = HttpRouter.add(
  "POST",
  "/api/dictation/audio",
  Effect.gen(function* () {
    const session = yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = new URL(request.url, "http://localhost").searchParams;
    const id = query.get("id") ?? "";
    const config = yield* ServerConfig.ServerConfig;
    if (!RECORDING_ID.test(id)) {
      return HttpServerResponse.text("Invalid recording identifier.", { status: 400 });
    }
    const audio = yield* request.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(DICTATION_AUDIO_MAX_BYTES),
      ),
      Effect.option,
    );
    if (Option.isNone(audio) || audio.value.byteLength > DICTATION_AUDIO_MAX_BYTES) {
      return HttpServerResponse.text("The recording is too large.", { status: 413 });
    }
    const offset = Number(query.get("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return HttpServerResponse.text("Invalid offset.", { status: 400 });
    }
    const result = yield* Effect.tryPromise(() =>
      submitRecording({
        directory: config.stateDir,
        owner: session.subject,
        id,
        project: query.get("project") ?? "",
        audio: audio.value,
        offset,
        final: query.get("final") !== "0",
      }),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("dictation.audio_submit_failed", { recordingId: id, cause }),
      ),
    );
    if (result.kind === "gap") {
      return HttpServerResponse.jsonUnsafe({ expected: result.expected }, { status: 409 });
    }
    return HttpServerResponse.jsonUnsafe(result.state);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text("The local speech service could not take the recording.", {
          status: 502,
        }),
      ),
    ),
  ),
);
