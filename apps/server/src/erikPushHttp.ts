import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as ServerConfig from "./config.ts";
import { registerPushDevice, sendPush } from "./erikPush.ts";
import { authenticateRawRouteWithScope } from "./http.ts";

const PushDeviceRequest = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  appId: Schema.String.check(Schema.isMaxLength(200)),
  label: Schema.String.check(Schema.isMaxLength(200)),
});

const PushSendRequest = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  message: Schema.String.check(Schema.isMaxLength(4000)),
  class: Schema.Literals(["urgent", "high", "normal", "low", "code"]),
  // `/dictate` on the end opens the thread with dictation recording (Android app).
  path: Schema.optional(
    Schema.String.check(Schema.isPattern(/^\/threads\/[^/?#]+\/[^/?#]+(?:\/dictate)?$/)),
  ),
  url: Schema.optional(Schema.String.check(Schema.isPattern(/^https?:\/\//))),
  code: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
});

const decodeDevice = Schema.decodeUnknownEffect(PushDeviceRequest);
const decodeSend = Schema.decodeUnknownEffect(PushSendRequest);

/** The Android app registers its FCM token here (see `erikPush.ts`). */
export const layerPushDeviceRoute = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return HttpRouter.add(
      "POST",
      "/api/push/devices",
      Effect.gen(function* () {
        yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* decodeDevice(yield* request.json);
        const devices = yield* Effect.tryPromise(() => registerPushDevice(stateDir, body));
        yield* Effect.logInfo("push.device_registered", { label: body.label, devices });
        return HttpServerResponse.jsonUnsafe({ registered: true, devices });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
        Effect.tapError((cause) => Effect.logError("push.register_failed", { cause })),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("The push request failed.", { status: 400 }),
        ),
      ),
    );
  }),
);

/** Agents' phone notifications (`notify-erik`, Executor `notify`) go out here. */
export const layerPushSendRoute = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return HttpRouter.add(
      "POST",
      "/api/push/send",
      Effect.gen(function* () {
        yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* decodeSend(yield* request.json);
        const result = yield* Effect.tryPromise(() => sendPush(stateDir, body));
        if (result.errors.length > 0) {
          yield* Effect.logWarning("push.send_partial", { ...result });
        }
        return HttpServerResponse.jsonUnsafe(result, {
          status: result.delivered > 0 ? 200 : 503,
        });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
        Effect.tapError((cause) => Effect.logError("push.send_failed", { cause })),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("The push request failed.", { status: 400 }),
        ),
      ),
    );
  }),
);
