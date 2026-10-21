package expo.modules.t3voicecall

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import androidx.annotation.OptIn
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingDeque
import kotlin.math.max
import kotlin.math.min

/**
 * The call's only speaker: one streaming AudioTrack with voice-communication
 * usage for the whole session. It plays the replies and the cue on the call's
 * route, and between them it plays silence, which keeps the app the owner of
 * communication mode (Android drops the mode, and with it the headset route,
 * about 6 s after the owner stops playing or recording voice audio).
 *
 * Clips are 16-bit WAV. Speed changes are done in software (Sonic, from
 * media3), as AudioTrack speed is unreliable on voice outputs.
 */
@OptIn(UnstableApi::class)
class VoicePlayer(private val onEvent: (String, Map<String, Any>) -> Unit) {
  private class Clip(val id: String, val samples: ShortArray) {
    var startFrame = -1L
    var endFrame = -1L
    var written = 0
    // Silence written while the clip was paused, so progress counts only the clip.
    var gap = 0L
    var lastProgress = -1L
  }

  private val queue = LinkedBlockingDeque<Clip>()
  private val inFlight = ArrayList<Clip>()
  private val lock = Object()
  private var track: AudioTrack? = null
  private var thread: Thread? = null
  @Volatile private var running = false
  @Volatile private var paused = false
  @Volatile private var generation = 0
  private var framesWritten = 0L
  private var current: Clip? = null

  fun start() {
    if (running) return
    running = true
    track = newTrack()
    thread = Thread(::loop, "t3-voice-player").apply { start() }
  }

  fun stop() {
    running = false
    thread?.interrupt()
    thread?.join(500)
    thread = null
    track?.let {
      runCatching { it.stop() }
      it.release()
    }
    track = null
    queue.clear()
    synchronized(lock) { inFlight.clear() }
  }

  /** Decodes, time-stretches and queues a clip; `ended` follows once it has been heard. */
  fun play(id: String, wavBase64: String, speed: Float, startFraction: Double) {
    val samples = prepare(Base64.decode(wavBase64, Base64.DEFAULT), speed, startFraction)
    queue.add(Clip(id, samples))
  }

  /** Drops everything queued or playing, at once. */
  fun clear() {
    synchronized(lock) {
      queue.clear()
      inFlight.clear()
      current = null
      generation++
      // Cut what is already in the track's buffer: a fresh track starts silent.
      track?.let {
        runCatching {
          it.pause()
          it.flush()
          it.release()
        }
      }
      track = newTrack()
      framesWritten = 0
      paused = false
    }
  }

  // The track keeps playing silence while paused: a paused track would let the
  // communication mode, and the headset route, lapse.
  fun pause() {
    paused = true
  }

  fun resume() {
    paused = false
  }

  private fun newTrack(): AudioTrack {
    val min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    return AudioTrack.Builder()
      .setAudioAttributes(VOICE_ATTRIBUTES)
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build()
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(max(min * 2, RATE / 5 * 2))
      .build()
      .apply { play() }
  }

  private fun loop() {
    val silence = ShortArray(CHUNK)
    while (running) {
      val output: AudioTrack
      val chunk: ShortArray
      val count: Int
      synchronized(lock) {
        output = track ?: return
        if (current == null) current = queue.poll()?.also { inFlight.add(it) }
        val clip = current
        if (clip == null || paused) {
          chunk = silence
          count = CHUNK
          if (clip != null && clip.startFrame >= 0) clip.gap += CHUNK
        } else {
          if (clip.startFrame < 0) clip.startFrame = framesWritten
          count = min(CHUNK, clip.samples.size - clip.written)
          chunk = clip.samples.copyOfRange(clip.written, clip.written + count)
          clip.written += count
          if (clip.written >= clip.samples.size) {
            clip.endFrame = framesWritten + count
            current = null
          }
        }
      }
      // A track released by clear() just returns an error here; the next round uses the new one.
      val written = runCatching { output.write(chunk, 0, count, AudioTrack.WRITE_BLOCKING) }.getOrDefault(0)
      synchronized(lock) {
        if (output === track && written > 0) framesWritten += written
      }
      report(output)
    }
  }

  /** Progress and `ended` follow the playback head, i.e. what has actually been heard. */
  private fun report(output: AudioTrack) {
    val done = ArrayList<Clip>()
    val progress = ArrayList<Pair<Clip, Double>>()
    synchronized(lock) {
      if (output !== track) return
      val head = output.playbackHeadPosition.toLong() and 0xffffffffL
      for (clip in inFlight) {
        if (clip.startFrame < 0 || head < clip.startFrame) continue
        val length = clip.samples.size.toLong().coerceAtLeast(1)
        if (clip.endFrame >= 0 && head >= clip.endFrame) {
          done.add(clip)
        } else if (head - clip.lastProgress >= RATE / 5) {
          clip.lastProgress = head
          progress.add(clip to ((head - clip.startFrame - clip.gap).toDouble() / length).coerceIn(0.0, 1.0))
        }
      }
      inFlight.removeAll(done.toSet())
    }
    for ((clip, fraction) in progress) onEvent("progress", mapOf("id" to clip.id, "fraction" to fraction))
    for (clip in done) onEvent("ended", mapOf("id" to clip.id))
  }

  companion object {
    const val RATE = 24000
    private const val CHUNK = RATE / 50 // 20 ms
    val VOICE_ATTRIBUTES: AudioAttributes =
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /** Mono 16-bit PCM at the track's rate and the requested speed. */
    fun prepare(wav: ByteArray, speed: Float, startFraction: Double): ShortArray {
      val (rate, channels, pcm) = readWav(wav)
      var mono = if (channels == 1) pcm else ShortArray(pcm.size / channels) { pcm[it * channels] }
      if (startFraction > 0) mono = mono.copyOfRange((mono.size * startFraction.coerceIn(0.0, 1.0)).toInt(), mono.size)
      if (rate == RATE && speed == 1f) return mono
      val sonic = SonicAudioProcessor()
      sonic.setSpeed(speed)
      sonic.setPitch(1f)
      sonic.setOutputSampleRateHz(RATE)
      sonic.configure(AudioProcessor.AudioFormat(rate, 1, AudioFormat.ENCODING_PCM_16BIT))
      sonic.flush(AudioProcessor.StreamMetadata.DEFAULT)
      val input = ByteBuffer.allocateDirect(mono.size * 2).order(ByteOrder.nativeOrder())
      input.asShortBuffer().put(mono)
      val out = java.io.ByteArrayOutputStream()
      fun drain() {
        val buffer = sonic.output
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        out.write(bytes)
      }
      while (input.hasRemaining()) {
        sonic.queueInput(input)
        drain()
      }
      sonic.queueEndOfStream()
      while (!sonic.isEnded) drain()
      val result = ByteBuffer.wrap(out.toByteArray()).order(ByteOrder.nativeOrder()).asShortBuffer()
      return ShortArray(result.remaining()).also { result.get(it) }
    }

    /** Sample rate, channels and samples of a 16-bit PCM WAV. */
    fun readWav(wav: ByteArray): Triple<Int, Int, ShortArray> {
      val buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
      var rate = RATE
      var channels = 1
      var offset = 12
      while (offset + 8 <= wav.size) {
        val id = String(wav, offset, 4, Charsets.US_ASCII)
        val size = buffer.getInt(offset + 4)
        if (id == "fmt ") {
          channels = buffer.getShort(offset + 10).toInt()
          rate = buffer.getInt(offset + 12)
        } else if (id == "data") {
          val length = min(size.toLong() and 0xffffffffL, (wav.size - offset - 8).toLong()).toInt()
          val samples = ShortArray(length / 2)
          ByteBuffer.wrap(wav, offset + 8, length).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples)
          return Triple(rate, channels, samples)
        }
        offset += 8 + size + (size and 1)
      }
      throw IllegalArgumentException("Not a WAV clip.")
    }
  }
}
