import {
  AuthOrchestrationOperateScope,
  DictationRequest,
  DictationState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { DictationDelivery, speechServiceUrl } from "./DictationDelivery.ts";
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
