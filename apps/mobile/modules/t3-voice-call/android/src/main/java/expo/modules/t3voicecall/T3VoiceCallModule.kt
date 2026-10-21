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
      VoiceCall.listener = { event, data ->
        sendEvent("onVoiceCallEvent", data + mapOf("type" to event))
      }
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

    Function("route") { VoiceCall.route() }

    Function("audioLog") { VoiceCall.audioLog() }

    // Clips decode and time-stretch off the JS thread.
    AsyncFunction("play") { id: String, wav: String, speed: Double, startFraction: Double ->
      VoiceCall.play(id, wav, speed, startFraction)
    }

    Function("clearPlayback") { VoiceCall.clearPlayback() }

    Function("pausePlayback") { VoiceCall.pausePlayback() }

    Function("resumePlayback") { VoiceCall.resumePlayback() }

    Function("prepareRecording") { VoiceCall.prepareRecording() }

    // The microphone is open for the whole call (on the call's route); a turn
    // only records what it hears. The argument is kept for older callers.
    AsyncFunction("startRecording") { _: Boolean -> VoiceCall.startRecording() }

    AsyncFunction("stopRecording") { VoiceCall.stopRecording() }

    Function("recordingStatus") { VoiceCall.status() }
  }
}
