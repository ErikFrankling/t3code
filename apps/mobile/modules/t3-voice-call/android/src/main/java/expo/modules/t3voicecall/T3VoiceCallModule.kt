package expo.modules.t3voicecall

import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3VoiceCallModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3VoiceCall")

    Events("onVoiceCallEvent")

    OnCreate {
      VoiceCall.listener = { event -> sendEvent("onVoiceCallEvent", mapOf("type" to event)) }
    }

    OnDestroy {
      VoiceCall.listener = null
      VoiceCall.stop()
    }

    Function("start") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      VoiceCall.start(context, context as? ReactContext)
    }

    Function("stop") { VoiceCall.stop() }

    Function("isActive") { VoiceCall.active }

    Function("setListening") { listening: Boolean -> VoiceCall.setListening(listening) }

    Function("prepareRecording") { VoiceCall.prepareRecording() }

    AsyncFunction("startRecording") { preferBluetooth: Boolean ->
      VoiceCall.startRecording(preferBluetooth)
    }

    AsyncFunction("stopRecording") { VoiceCall.stopRecording() }

    Function("recordingStatus") { VoiceCall.status() }
  }
}
