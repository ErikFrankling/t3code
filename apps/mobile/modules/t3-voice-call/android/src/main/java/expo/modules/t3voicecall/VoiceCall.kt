package expo.modules.t3voicecall

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.VolumeProvider
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.KeyEvent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.io.File

/**
 * Voice mode on Android: one phone call from turning it on until hanging up.
 *
 * The audio is set up once, at the start, and held until the end: focus,
 * communication mode and one route ([CallAudioSession]), one speaker
 * ([VoicePlayer], which plays the replies and silence in between) and one open
 * microphone ([VoiceCapture]). A turn only starts or stops encoding what the
 * microphone already hears; nothing switches the mode or the route between
 * turns, so a Bluetooth headset stays on its call profile the whole time
 * (switching it in and out of a call for every turn made the audio glitch).
 * [AudioLog] records every mode and route change.
 *
 * Around it: a foreground service keeps the microphone and the speaker usable
 * with the screen off, a wake lock keeps the CPU up between turns, and a
 * headless JS task keeps React Native's timers running in the background. A
 * media session takes the earbud button and, while you talk, the volume keys
 * (a remote volume provider, so the volume does not change); a headset
 * hanging up its call link counts as a tap (see CallAudioSession).
 */
@SuppressLint("StaticFieldLeak")
object VoiceCall {
  var listener: ((String, Map<String, Any>) -> Unit)? = null

  private val main = Handler(Looper.getMainLooper())
  private var context: Context? = null
  private var session: MediaSession? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var taskContext: HeadlessJsTaskContext? = null
  private var taskId: Int? = null
  private var listening = false
  private var volumeReceiver: BroadcastReceiver? = null
  private var restoringVolume = false
  private var lastPress = 0L
  private var audioSession: CallAudioSession? = null
  private var player: VoicePlayer? = null
  private var capture: VoiceCapture? = null
  private var recordingFile: File? = null

  val active: Boolean
    get() = context != null

  fun emit(event: String, data: Map<String, Any> = emptyMap()) {
    main.post { listener?.invoke(event, data) }
  }

  /** One press per gesture: several paths can see the same one. */
  private fun press(event: String, data: Map<String, Any> = emptyMap()) {
    val now = SystemClock.elapsedRealtime()
    if (now - lastPress < 700) return
    lastPress = now
    emit(event, data)
  }

  private fun sessionEvent(event: String, data: Map<String, Any>) {
    AudioLog.write("event $event $data")
    emit(event, data)
  }

  fun start(appContext: Context, reactContext: ReactContext?) {
    if (context != null) return
    val ctx = appContext.applicationContext
    context = ctx
    AudioLog.open(ctx, main)
    ContextCompat.startForegroundService(ctx, Intent(ctx, VoiceCallService::class.java))
    wakeLock =
      ctx.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "t3code:voice-call")
        .apply {
          setReferenceCounted(false)
          acquire()
        }
    try {
      // Order matters: focus and mode first, then the player and the
      // microphone (they make the app the mode's owner), then the route.
      val route = if (Build.VERSION.SDK_INT >= 31) CallAudioSession(ctx, main, ::sessionEvent) else null
      audioSession = route
      route?.start()
      player = VoicePlayer(::emit).apply { start() }
      capture = VoiceCapture().apply { start() }
      route?.pickRoute() ?: legacyRoute(ctx)
      AudioLog.write("call audio held: player and microphone open")
    } catch (error: Exception) {
      stop()
      throw error
    }
    session = mediaSession(ctx)
    applyListening()
    if (reactContext != null) {
      UiThreadUtil.runOnUiThread {
        try {
          val tasks = HeadlessJsTaskContext.getInstance(reactContext)
          taskContext = tasks
          taskId = tasks.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
        } catch (error: Exception) {
          android.util.Log.w("T3VoiceCall", "No background JS task", error)
        }
      }
    }
  }

  fun stop() {
    val ctx = context ?: return
    setListening(false)
    session?.release()
    session = null
    capture?.stop()
    capture = null
    recordingFile = null
    // Route, then mode, then focus (CallAudioSession.stop), and the player last
    // so the mode is never left without its owner.
    audioSession?.stop()
    audioSession = null
    if (Build.VERSION.SDK_INT < 31) ctx.getSystemService(AudioManager::class.java).apply {
      @Suppress("DEPRECATION")
      isSpeakerphoneOn = false
      mode = AudioManager.MODE_NORMAL
    }
    player?.stop()
    player = null
    // The system reports the switch out of the mode a moment later.
    main.postDelayed({ if (context == null) AudioLog.close() }, 1500)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    val tasks = taskContext
    val id = taskId
    taskContext = null
    taskId = null
    if (tasks != null && id != null) {
      UiThreadUtil.runOnUiThread { if (tasks.isTaskRunning(id)) tasks.finishTask(id) }
    }
    ctx.stopService(Intent(ctx, VoiceCallService::class.java))
    context = null
  }

  @Suppress("DEPRECATION")
  private fun legacyRoute(ctx: Context) {
    val audio = ctx.getSystemService(AudioManager::class.java)
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    audio.isSpeakerphoneOn = true
    sessionEvent("route", mapOf("kind" to "speaker", "name" to "Speaker"))
  }

  private fun mediaSession(ctx: Context) =
    MediaSession(ctx, "t3code-voice-call").apply {
      setCallback(
        object : MediaSession.Callback() {
          override fun onMediaButtonEvent(intent: Intent): Boolean {
            val event = mediaButton(intent) ?: return super.onMediaButtonEvent(intent)
            if (event.action == KeyEvent.ACTION_UP) press("button", mapOf("source" to "media"))
            return true
          }

          override fun onPlay() = press("button", mapOf("source" to "media"))

          override fun onPause() = press("button", mapOf("source" to "media"))
        },
        main,
      )
      setPlaybackState(playbackState(PlaybackState.STATE_PLAYING))
      isActive = true
    }

  private fun playbackState(state: Int) =
    PlaybackState.Builder()
      .setActions(
        PlaybackState.ACTION_PLAY or
          PlaybackState.ACTION_PAUSE or
          PlaybackState.ACTION_PLAY_PAUSE or
          PlaybackState.ACTION_SKIP_TO_NEXT
      )
      .setState(state, 0, 1f)
      .build()

  private fun mediaButton(intent: Intent): KeyEvent? {
    val event =
      if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
      } else {
        @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
      }
    return event?.takeIf {
      it.keyCode == KeyEvent.KEYCODE_HEADSETHOOK ||
        it.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
        it.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY ||
        it.keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE ||
        it.keyCode == KeyEvent.KEYCODE_MEDIA_NEXT ||
        it.keyCode == KeyEvent.KEYCODE_MEDIA_STOP
    }
  }

  /** While true the volume keys are the turn button; otherwise they set the call volume. */
  fun setListening(value: Boolean) {
    listening = value
    applyListening()
  }

  private fun applyListening() {
    val ctx = context ?: return
    val media = session ?: return
    if (listening) {
      // Back on top of the media button stack after the reply was read.
      media.setPlaybackState(playbackState(PlaybackState.STATE_PAUSED))
      media.setPlaybackState(playbackState(PlaybackState.STATE_PLAYING))
      media.setPlaybackToRemote(
        object : VolumeProvider(VOLUME_CONTROL_RELATIVE, 10, 5) {
          override fun onAdjustVolume(direction: Int) {
            // Kept mid-range, so a press never hits a limit and gets dropped.
            currentVolume = 5
            if (direction != 0) press("volume", mapOf("direction" to if (direction > 0) "up" else "down"))
          }
        }
      )
      if (volumeReceiver == null) {
        val receiver = volumeFallback(ctx)
        volumeReceiver = receiver
        ContextCompat.registerReceiver(
          ctx,
          receiver,
          IntentFilter(VOLUME_CHANGED),
          ContextCompat.RECEIVER_NOT_EXPORTED,
        )
      }
    } else {
      // The keys then set the volume the call is heard at.
      media.setPlaybackToLocal(VoicePlayer.VOICE_ATTRIBUTES)
      volumeReceiver?.let { ctx.unregisterReceiver(it) }
      volumeReceiver = null
    }
  }

  private fun volumeFallback(ctx: Context) =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val stream = intent.getIntExtra(EXTRA_STREAM, -1)
        val value = intent.getIntExtra(EXTRA_VALUE, -1)
        val previous = intent.getIntExtra(EXTRA_PREVIOUS, -1)
        if (!listening || stream < 0 || previous < 0 || value == previous) return
        if (restoringVolume) {
          restoringVolume = false
          return
        }
        restoringVolume = true
        try {
          ctx.getSystemService(AudioManager::class.java).setStreamVolume(stream, previous, 0)
        } catch (_: SecurityException) {
          restoringVolume = false
        }
        press("volume", mapOf("direction" to if (value > previous) "up" else "down"))
      }
    }

  // Replies play on the call's route, through the call's one speaker.
  fun play(id: String, wav: String, speed: Double, startFraction: Double) {
    AudioLog.write("play $id")
    (player ?: throw IllegalStateException("Voice mode is not on.")).play(id, wav, speed.toFloat(), startFraction)
  }

  fun clearPlayback() = player?.clear()

  fun pausePlayback() = player?.pause()

  fun resumePlayback() = player?.resume()

  // A turn: the open microphone's audio goes into a file JS uploads while it grows.
  fun prepareRecording(): String {
    val ctx = context ?: throw IllegalStateException("Voice mode is not on.")
    val file = File(ctx.cacheDir, "voice-call-${System.currentTimeMillis()}.aac")
    recordingFile = file
    return "file://${file.absolutePath}"
  }

  /** Starts encoding the microphone, which is already open; the mode and route stay as they are. */
  fun startRecording() {
    val file = recordingFile ?: throw IllegalStateException("No recording prepared.")
    (capture ?: throw IllegalStateException("Voice mode is not on.")).begin(file)
    AudioLog.write("turn start: recording ${file.name}")
  }

  fun stopRecording() {
    capture?.end()
    AudioLog.write("turn end")
  }

  fun status(): Map<String, Any> =
    (capture?.status() ?: mapOf("isRecording" to false, "durationMillis" to 0L, "metering" to -160.0)) +
      mapOf("bluetooth" to (route()["kind"] == "bluetooth"))

  fun route(): Map<String, Any> = audioSession?.route() ?: mapOf("kind" to "speaker", "name" to "Speaker")

  fun audioLog(): String = AudioLog.read()

  const val TASK = "T3VoiceCall"
  private const val VOLUME_CHANGED = "android.media.VOLUME_CHANGED_ACTION"
  private const val EXTRA_STREAM = "android.media.EXTRA_VOLUME_STREAM_TYPE"
  private const val EXTRA_VALUE = "android.media.EXTRA_VOLUME_STREAM_VALUE"
  private const val EXTRA_PREVIOUS = "android.media.EXTRA_PREV_VOLUME_STREAM_VALUE"
}
