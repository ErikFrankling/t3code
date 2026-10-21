package expo.modules.t3voicecall

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.SystemClock
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * The call's microphone: one AudioRecord with the voice-communication source
 * (echo cancellation and noise suppression, and it follows the call's route,
 * e.g. the headset), open for the whole session. Starting the microphone
 * once, while the app is on screen, avoids every per-turn problem: starting
 * from the background, waiting for the headset microphone, losing the first
 * word. Between turns the frames are dropped; during a turn they are encoded
 * to AAC in ADTS frames, a file that can be uploaded while it grows (the same
 * format the normal dictation uploads).
 */
class VoiceCapture {
  private class Segment(val file: File) {
    // Appends: a paused recording continues in the same file. ADTS frames stand alone.
    val output = FileOutputStream(file, true)
    val codec: MediaCodec =
      MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
        configure(
          MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 48000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, FRAME * 2 * 4)
          },
          null,
          null,
          MediaCodec.CONFIGURE_FLAG_ENCODE,
        )
        start()
      }
    val started = SystemClock.elapsedRealtime()
    var samples = 0L
  }

  private var record: AudioRecord? = null
  private var thread: Thread? = null
  @Volatile private var running = false
  private val lock = Object()
  private var segment: Segment? = null
  @Volatile var level = -160.0
    private set

  val sessionId: Int
    get() = record?.audioSessionId ?: 0

  @SuppressLint("MissingPermission") // The session starts only after RECORD_AUDIO was granted.
  fun start(source: Int = MediaRecorder.AudioSource.VOICE_COMMUNICATION, device: android.media.AudioDeviceInfo? = null) {
    if (running) return
    val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val input =
      AudioRecord(
        source,
        RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        max(min * 2, FRAME * 2 * 8),
      )
    check(input.state == AudioRecord.STATE_INITIALIZED) { "The microphone could not be opened." }
    device?.let { input.preferredDevice = it }
    input.startRecording()
    record = input
    running = true
    thread = Thread(::loop, "t3-voice-capture").apply { start() }
  }

  fun stop() {
    running = false
    thread?.join(500)
    thread = null
    synchronized(lock) { segment?.let { finish(it) } }
    segment = null
    record?.let {
      runCatching { it.stop() }
      it.release()
    }
    record = null
  }

  /** Starts encoding the microphone onto the end of `file` (a paused dictation resumes in it). */
  fun begin(file: File) {
    synchronized(lock) {
      segment?.let { finish(it) }
      segment = Segment(file)
    }
  }

  /** Ends the turn: the rest is encoded and the file is complete. */
  fun end() {
    synchronized(lock) {
      segment?.let { finish(it) }
      segment = null
    }
  }

  fun status(): Map<String, Any> =
    synchronized(lock) {
      val open = segment
      mapOf(
        "isRecording" to (open != null),
        "durationMillis" to (open?.let { it.samples * 1000 / RATE } ?: 0L),
        "metering" to level,
      )
    }

  private fun loop() {
    val frame = ShortArray(FRAME)
    while (running) {
      val input = record ?: break
      val read = input.read(frame, 0, FRAME)
      if (read <= 0) continue
      var sum = 0.0
      for (index in 0 until read) sum += frame[index].toDouble() * frame[index]
      val rms = sqrt(sum / read) / 32768.0
      level = if (rms > 0) 20 * log10(rms) else -160.0
      synchronized(lock) {
        val open = segment ?: return@synchronized
        encode(open, frame, read, false)
        open.samples += read
      }
    }
  }

  private fun encode(open: Segment, frame: ShortArray, count: Int, last: Boolean) {
    val index = open.codec.dequeueInputBuffer(10_000)
    if (index >= 0) {
      val buffer = open.codec.getInputBuffer(index)!!
      buffer.clear()
      buffer.order(ByteOrder.LITTLE_ENDIAN)
      for (sample in 0 until count) buffer.putShort(frame[sample])
      open.codec.queueInputBuffer(
        index,
        0,
        count * 2,
        open.samples * 1_000_000 / RATE,
        if (last) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0,
      )
    }
    drain(open, last)
  }

  private fun drain(open: Segment, untilEnd: Boolean) {
    val info = MediaCodec.BufferInfo()
    // At the end of a turn, wait for the encoder to flush, but never hang on it (2 s).
    var waits = 0
    while (true) {
      val index = open.codec.dequeueOutputBuffer(info, if (untilEnd) 10_000 else 0)
      if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
        if (untilEnd && ++waits < 200) continue else return
      }
      if (index < 0) continue
      val buffer = open.codec.getOutputBuffer(index)!!
      if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
        val data = ByteArray(info.size)
        buffer.position(info.offset)
        buffer.get(data)
        open.output.write(adtsHeader(info.size))
        open.output.write(data)
        open.output.flush()
      }
      open.codec.releaseOutputBuffer(index, false)
      if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
    }
  }

  private fun finish(open: Segment) {
    runCatching {
      encode(open, ShortArray(0), 0, true)
      open.codec.stop()
    }
    open.codec.release()
    open.output.close()
  }

  companion object {
    const val RATE = 16000
    private const val FRAME = RATE / 50 // 20 ms

    /** ADTS header for one AAC-LC frame, 16 kHz mono. */
    fun adtsHeader(payload: Int): ByteArray {
      val length = payload + 7
      val profile = 2 // AAC LC
      val frequency = 8 // 16 kHz
      val channels = 1
      return byteArrayOf(
        0xFF.toByte(),
        0xF1.toByte(),
        (((profile - 1) shl 6) + (frequency shl 2) + (channels shr 2)).toByte(),
        (((channels and 3) shl 6) + (length shr 11)).toByte(),
        ((length and 0x7FF) shr 3).toByte(),
        (((length and 7) shl 5) + 0x1F).toByte(),
        0xFC.toByte(),
      )
    }
  }
}

/** Cuts an AAC (ADTS) file back to its last complete frame, as after the app was killed mid-write. */
fun repairAdts(file: File): Long {
  if (!file.exists()) return 0
  val data = file.readBytes()
  var offset = 0
  while (offset + 7 <= data.size) {
    if (data[offset].toInt() and 0xFF != 0xFF || data[offset + 1].toInt() and 0xF0 != 0xF0) break
    val length =
      ((data[offset + 3].toInt() and 3) shl 11) or
        ((data[offset + 4].toInt() and 0xFF) shl 3) or
        ((data[offset + 5].toInt() and 0xFF) shr 5)
    if (length < 7 || offset + length > data.size) break
    offset += length
  }
  if (offset < data.size) java.io.RandomAccessFile(file, "rw").use { it.setLength(offset.toLong()) }
  return offset.toLong()
}
