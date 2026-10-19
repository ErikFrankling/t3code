package expo.modules.t3voicecall

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaRecorder
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
import kotlin.math.log10

/**
 * Voice mode on Android: one "call" from turning it on until hanging up.
 *
 * - The foreground service keeps the microphone and playback usable from the
 *   background; a wake lock keeps the CPU up between turns.
 * - A headless JS task keeps React Native's timers running while the app is
 *   in the background (they stop otherwise, and polling with them).
 * - A media session takes the earbud button, and while you talk, the volume
 *   keys: a remote volume provider gets the presses without changing the
 *   volume. Where a phone routes them elsewhere, a changed stream volume
 *   counts as a press and is put back.
 * - Recording goes to an AAC (ADTS) file that can be uploaded while it grows,
 *   as the normal dictation does, from a Bluetooth headset's microphone when
 *   one is connected.
 */
@SuppressLint("StaticFieldLeak")
object VoiceCall {
  var listener: ((String) -> Unit)? = null

  private val main = Handler(Looper.getMainLooper())
  private var context: Context? = null
  private var session: MediaSession? = null
  private var silence: AudioTrack? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var taskContext: HeadlessJsTaskContext? = null
  private var taskId: Int? = null
  private var listening = false
  private var volumeReceiver: BroadcastReceiver? = null
  private var restoringVolume = false
  private var lastPress = 0L

  private var recorder: MediaRecorder? = null
  private var recordingFile: File? = null
  private var recordingStarted = 0L
  private var bluetooth = false

  val active: Boolean
    get() = context != null

  fun emit(event: String) {
    main.post { listener?.invoke(event) }
  }

  /** One press per gesture: the session and the volume fallback can both see it. */
  private fun press(event: String) {
    val now = SystemClock.elapsedRealtime()
    if (now - lastPress < 700) return
    lastPress = now
    emit(event)
  }

  fun start(appContext: Context, reactContext: ReactContext?) {
    if (context != null) return
    val ctx = appContext.applicationContext
    context = ctx
    ContextCompat.startForegroundService(ctx, Intent(ctx, VoiceCallService::class.java))
    wakeLock =
      ctx.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "t3code:voice-call")
        .apply {
          setReferenceCounted(false)
          acquire()
        }
    session =
      MediaSession(ctx, "t3code-voice-call").apply {
        setCallback(
          object : MediaSession.Callback() {
            override fun onMediaButtonEvent(intent: Intent): Boolean {
              val event = mediaButton(intent) ?: return super.onMediaButtonEvent(intent)
              if (event.action == KeyEvent.ACTION_UP) press("button")
              return true
            }

            override fun onPlay() = press("button")

            override fun onPause() = press("button")
          },
          main,
        )
        setPlaybackState(playbackState(PlaybackState.STATE_PLAYING))
        isActive = true
      }
    silence = silentLoop()
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
    stopRecording()
    setListening(false)
    session?.release()
    session = null
    silence?.let {
      it.stop()
      it.release()
    }
    silence = null
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

  /**
   * Android gives the earbud button only to a session of an app that is playing
   * audio; between the replies nothing plays, so the call plays silence.
   */
  private fun silentLoop(): AudioTrack? =
    try {
      val frames = 16000
      AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(16000)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        )
        .setTransferMode(AudioTrack.MODE_STATIC)
        .setBufferSizeInBytes(frames * 2)
        .build()
        .apply {
          write(ShortArray(frames), 0, frames)
          setLoopPoints(0, frames, -1)
          play()
        }
    } catch (error: Exception) {
      android.util.Log.w("T3VoiceCall", "No silent loop", error)
      null
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

  /** While true the volume keys are the turn button; otherwise they set the volume. */
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
            if (direction != 0) press("volume")
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
      media.setPlaybackToLocal(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
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
        press("volume")
      }
    }

  fun prepareRecording(): String {
    val ctx = context ?: throw IllegalStateException("Voice mode is not on.")
    val file = File(ctx.cacheDir, "voice-call-${System.currentTimeMillis()}.aac")
    recordingFile = file
    return "file://${file.absolutePath}"
  }

  @Synchronized
  fun startRecording(preferBluetooth: Boolean) {
    val ctx = context ?: throw IllegalStateException("Voice mode is not on.")
    val file = recordingFile ?: throw IllegalStateException("No recording prepared.")
    stopRecording()
    recordingFile = file
    bluetooth = preferBluetooth && useBluetoothMicrophone(ctx)
    val media =
      (if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder())
        .apply {
          setAudioSource(
            if (bluetooth) MediaRecorder.AudioSource.VOICE_COMMUNICATION
            else MediaRecorder.AudioSource.MIC
          )
          setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
          setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
          setAudioSamplingRate(16000)
          setAudioChannels(1)
          setAudioEncodingBitRate(48000)
          setOutputFile(file.absolutePath)
          prepare()
          start()
        }
    recorder = media
    recordingStarted = SystemClock.elapsedRealtime()
  }

  @Synchronized
  fun stopRecording() {
    val media = recorder ?: return
    recorder = null
    try {
      media.stop()
    } catch (_: RuntimeException) {
      // Stopped right after starting: the file is just shorter.
    }
    media.release()
    if (bluetooth) releaseBluetoothMicrophone()
    bluetooth = false
  }

  fun status(): Map<String, Any> {
    val media = recorder
    val amplitude = media?.let { runCatching { it.maxAmplitude }.getOrDefault(0) } ?: 0
    return mapOf(
      "isRecording" to (media != null),
      "durationMillis" to (if (media != null) SystemClock.elapsedRealtime() - recordingStarted else 0L),
      "metering" to (if (amplitude > 0) 20 * log10(amplitude / 32767.0) else -160.0),
      "bluetooth" to bluetooth,
    )
  }

  private fun useBluetoothMicrophone(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < 31) return false
    val audio = ctx.getSystemService(AudioManager::class.java)
    val headset =
      audio.availableCommunicationDevices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
      } ?: return false
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    if (!audio.setCommunicationDevice(headset)) {
      audio.mode = AudioManager.MODE_NORMAL
      return false
    }
    // The headset's microphone takes a moment to come up; words before that are lost.
    val deadline = SystemClock.elapsedRealtime() + 2000
    while (audio.communicationDevice?.id != headset.id && SystemClock.elapsedRealtime() < deadline) {
      Thread.sleep(50)
    }
    Thread.sleep(300)
    return true
  }

  private fun releaseBluetoothMicrophone() {
    if (Build.VERSION.SDK_INT < 31) return
    val audio = context?.getSystemService(AudioManager::class.java) ?: return
    audio.clearCommunicationDevice()
    audio.mode = AudioManager.MODE_NORMAL
  }

  const val TASK = "T3VoiceCall"
  private const val VOLUME_CHANGED = "android.media.VOLUME_CHANGED_ACTION"
  private const val EXTRA_STREAM = "android.media.EXTRA_VOLUME_STREAM_TYPE"
  private const val EXTRA_VALUE = "android.media.EXTRA_VOLUME_STREAM_VALUE"
  private const val EXTRA_PREVIOUS = "android.media.EXTRA_PREV_VOLUME_STREAM_VALUE"
}
