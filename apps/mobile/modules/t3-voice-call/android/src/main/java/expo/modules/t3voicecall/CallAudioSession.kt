package expo.modules.t3voicecall

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import androidx.annotation.RequiresApi

/**
 * Voice mode's audio as one phone call: audio focus (music pauses, as for a
 * call), communication mode and one route (headset, else the speaker), taken
 * once at the start and held until hang-up. Nothing switches between turns, so
 * the headset stays on its call profile and nothing leaks to the phone's
 * speaker (the old per-turn switching broke recordings and leaked audio).
 *
 * Events: `route` (kind, name) when a route is in use, `routeLost` when the
 * headset went away (the call pauses rather than continue out loud), `button`
 * when the headset hung up its call link (an earbud tap during the call),
 * `interrupted` / `resumed` around a phone call or another app taking focus.
 *
 * Without a Telecom call on purpose: Telecom would take the volume keys and
 * turn an earbud tap into "end call" (docs/research/android-voice-call-audio.md).
 */
@RequiresApi(31)
class CallAudioSession(
  private val context: Context,
  private val handler: Handler,
  private val onEvent: (String, Map<String, Any>) -> Unit,
) {
  private val audio = context.getSystemService(AudioManager::class.java)
  private var focus: AudioFocusRequest? = null
  private var chosen: AudioDeviceInfo? = null
  private var requested: AudioDeviceInfo? = null
  private var lost = false
  private var interrupted = false
  private var active = false
  private var confirmTimeout: Runnable? = null
  private var retried = false

  private val deviceChanged =
    AudioManager.OnCommunicationDeviceChangedListener { device -> onDeviceChanged(device) }

  private val devices =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
        // A headset came (back): move the call to it.
        if (!active) return
        val current = chosen
        if (lost || current == null || current.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
          if (added.any { rank(it) in 0..2 }) pickRoute()
        }
      }

      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
        val current = chosen ?: return
        if (removed.any { it.id == current.id || sameHeadset(it, current) }) headsetLost()
      }
    }

  private val focusChanged =
    AudioManager.OnAudioFocusChangeListener { change ->
      when (change) {
        AudioManager.AUDIOFOCUS_LOSS,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
          if (!interrupted) {
            interrupted = true
            onEvent("interrupted", emptyMap())
          }
        }
        AudioManager.AUDIOFOCUS_GAIN -> {
          if (interrupted) {
            interrupted = false
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            pickRoute()
            onEvent("resumed", emptyMap())
          }
        }
      }
    }

  /** Takes focus, the mode and a route. The player and the capture must start right after. */
  fun start() {
    active = true
    val request =
      AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(VoicePlayer.VOICE_ATTRIBUTES)
        .setOnAudioFocusChangeListener(focusChanged, handler)
        .setWillPauseWhenDucked(true)
        .build()
    focus = request
    if (audio.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      // In a phone call: start anyway, as interrupted; focus comes back after it.
      interrupted = true
      onEvent("interrupted", emptyMap())
    }
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    audio.addOnCommunicationDeviceChangedListener(context.mainExecutor, deviceChanged)
    audio.registerAudioDeviceCallback(devices, handler)
  }

  /** Called once the keep-alive track plays: the app now owns the mode and may pick a route. */
  fun pickRoute() {
    if (!active) return
    val candidates =
      audio.availableCommunicationDevices
        .filter { rank(it) >= 0 && !it.productName.toString().contains(" Watch") }
        .sortedBy { rank(it) }
    val target = candidates.firstOrNull() ?: return
    lost = false
    retried = false
    setDevice(target)
  }

  private fun setDevice(target: AudioDeviceInfo) {
    requested = target
    if (audio.communicationDevice?.id == target.id) {
      confirmed(target)
      return
    }
    if (!audio.setCommunicationDevice(target)) {
      fallback(target)
      return
    }
    confirmTimeout?.let(handler::removeCallbacks)
    val timeout = Runnable {
      // A headset that never came up: once more, then the next device.
      if (requested?.id != target.id) return@Runnable
      if (!retried) {
        retried = true
        audio.clearCommunicationDevice()
        if (audio.setCommunicationDevice(target)) {
          handler.postDelayed(confirmTimeout!!, CONFIRM_MS)
          return@Runnable
        }
      }
      fallback(target)
    }
    confirmTimeout = timeout
    handler.postDelayed(timeout, CONFIRM_MS)
  }

  private fun fallback(failed: AudioDeviceInfo) {
    val next =
      audio.availableCommunicationDevices
        .filter { rank(it) > rank(failed) }
        .minByOrNull { rank(it) } ?: return
    retried = false
    setDevice(next)
  }

  private fun confirmed(device: AudioDeviceInfo) {
    confirmTimeout?.let(handler::removeCallbacks)
    confirmTimeout = null
    requested = null
    chosen = device
    onEvent("route", mapOf("kind" to kind(device), "name" to device.productName.toString()))
  }

  private fun onDeviceChanged(device: AudioDeviceInfo?) {
    if (!active) return
    val wanted = requested
    if (wanted != null && device?.id == wanted.id) {
      confirmed(device)
      return
    }
    val current = chosen ?: return
    if (device?.id == current.id || wanted != null) return
    val stillThere = audio.availableCommunicationDevices.any { it.id == current.id }
    if (current.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && stillThere) {
      // The headset hung up its call link while connected: an earbud tap
      // (AT+CHUP). It ends the turn; then the call link is set up again.
      onEvent("button", mapOf("source" to "headset"))
      handler.postDelayed({ if (active && !lost) setDevice(current) }, 300)
    } else if (!stillThere) {
      headsetLost()
    } else {
      setDevice(current)
    }
  }

  private fun headsetLost() {
    if (lost || !active) return
    val current = chosen ?: return
    if (current.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return
    lost = true
    chosen = null
    onEvent("routeLost", mapOf("name" to current.productName.toString()))
  }

  /** Lets go of the route, then the mode, then focus, so music resumes on the headset. */
  fun stop() {
    if (!active) return
    active = false
    confirmTimeout?.let(handler::removeCallbacks)
    confirmTimeout = null
    audio.removeOnCommunicationDeviceChangedListener(deviceChanged)
    audio.unregisterAudioDeviceCallback(devices)
    audio.clearCommunicationDevice()
    audio.mode = AudioManager.MODE_NORMAL
    focus?.let(audio::abandonAudioFocusRequest)
    focus = null
    chosen = null
    requested = null
  }

  fun route(): Map<String, Any> =
    chosen?.let { mapOf("kind" to kind(it), "name" to it.productName.toString()) }
      ?: mapOf("kind" to if (lost) "lost" else "none", "name" to "")

  companion object {
    private const val CONFIRM_MS = 5_000L

    /** LE Audio, then classic Bluetooth, then wired, then the speaker; never the earpiece. */
    fun rank(device: AudioDeviceInfo): Int =
      when (device.type) {
        AudioDeviceInfo.TYPE_BLE_HEADSET -> 0
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 1
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_USB_HEADSET -> 2
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> 3
        else -> -1
      }

    fun kind(device: AudioDeviceInfo): String =
      when (rank(device)) {
        0,
        1 -> "bluetooth"
        2 -> "wired"
        else -> "speaker"
      }

    private fun sameHeadset(a: AudioDeviceInfo, b: AudioDeviceInfo) =
      a.address.isNotEmpty() && a.address == b.address && rank(a) in 0..1 && rank(b) in 0..1  }
}
