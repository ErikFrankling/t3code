package expo.modules.t3voicecall

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What voice mode's call did to the phone's audio, for proof and diagnosis:
 * every change of the audio mode and of the communication device the system
 * reports (whoever made it), and the call's own steps. Written to logcat
 * (tag T3VoiceAudio) and to `voice-audio.log` in the app's files, which keeps
 * the last call: a call must show one switch into communication mode at its
 * start, one out at its end, and nothing in between.
 */
object AudioLog {
  private const val TAG = "T3VoiceAudio"
  private val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
  private var file: File? = null
  private var audio: AudioManager? = null
  private var modeListener: Any? = null
  private var deviceListener: Any? = null

  fun open(context: Context, handler: Handler) {
    file = File(context.filesDir, "voice-audio.log").apply { writeText("") }
    val manager = context.getSystemService(AudioManager::class.java)
    audio = manager
    write("call start: mode=${modeName(manager.mode)} device=${deviceName(currentDevice(manager))}")
    if (Build.VERSION.SDK_INT >= 31) {
      val onMode = AudioManager.OnModeChangedListener { mode -> write("mode -> ${modeName(mode)}") }
      val onDevice =
        AudioManager.OnCommunicationDeviceChangedListener { device -> write("communication device -> ${deviceName(device)}") }
      val executor = java.util.concurrent.Executor { handler.post(it) }
      manager.addOnModeChangedListener(executor, onMode)
      manager.addOnCommunicationDeviceChangedListener(executor, onDevice)
      modeListener = onMode
      deviceListener = onDevice
    }
  }

  fun close() {
    val manager = audio ?: return
    if (Build.VERSION.SDK_INT >= 31) {
      (modeListener as? AudioManager.OnModeChangedListener)?.let(manager::removeOnModeChangedListener)
      (deviceListener as? AudioManager.OnCommunicationDeviceChangedListener)?.let(
        manager::removeOnCommunicationDeviceChangedListener
      )
    }
    modeListener = null
    deviceListener = null
    write("call end: mode=${modeName(manager.mode)} device=${deviceName(currentDevice(manager))}")
    audio = null
  }

  /** One step of the call (`turn start`, `play`, ...), between the system's changes. */
  fun write(line: String) {
    Log.i(TAG, line)
    runCatching { file?.appendText("${time.format(Date())} $line\n") }
  }

  fun read(): String = runCatching { file?.readText() }.getOrNull() ?: ""

  private fun currentDevice(manager: AudioManager): AudioDeviceInfo? =
    if (Build.VERSION.SDK_INT >= 31) manager.communicationDevice else null

  fun modeName(mode: Int) =
    when (mode) {
      AudioManager.MODE_NORMAL -> "NORMAL"
      AudioManager.MODE_RINGTONE -> "RINGTONE"
      AudioManager.MODE_IN_CALL -> "IN_CALL"
      AudioManager.MODE_IN_COMMUNICATION -> "IN_COMMUNICATION"
      AudioManager.MODE_CALL_SCREENING -> "CALL_SCREENING"
      else -> "mode $mode"
    }

  fun deviceName(device: AudioDeviceInfo?): String =
    if (device == null) "none"
    else {
      val type =
        when (device.type) {
          AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET"
          AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
          AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
          AudioDeviceInfo.TYPE_USB_HEADSET -> "USB_HEADSET"
          AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "SPEAKER"
          AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "EARPIECE"
          else -> "type ${device.type}"
        }
      "$type (${device.productName})"
    }
}
