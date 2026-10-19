package expo.modules.t3voicecall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps voice mode alive with the screen off: a foreground service of type
 * microphone and media playback, started while the app is on screen and kept
 * for the whole "call", so every turn may record and play from the background
 * (Android 14+ refuses to start the microphone from the background otherwise).
 */
class VoiceCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_HANG_UP) {
      VoiceCall.emit("hangUp")
      return START_NOT_STICKY
    }
    val type =
      if (Build.VERSION.SDK_INT >= 30) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      } else {
        0
      }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this), type)
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    // mediaPlayback has no time limit today; if a future Android adds one, end cleanly.
    VoiceCall.emit("hangUp")
    stopSelf()
  }

  companion object {
    const val ACTION_HANG_UP = "expo.modules.t3voicecall.HANG_UP"
    private const val CHANNEL_ID = "t3-voice-call"
    private const val NOTIFICATION_ID = 7341

    fun notification(context: Context): Notification {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Voice mode", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while voice mode listens and reads replies aloud."
          }
        )
      }
      val immutable = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0
      val open =
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
          PendingIntent.getActivity(context, 0, it, immutable or PendingIntent.FLAG_UPDATE_CURRENT)
        }
      val hangUp =
        PendingIntent.getService(
          context,
          1,
          Intent(context, VoiceCallService::class.java).setAction(ACTION_HANG_UP),
          immutable or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle("Voice mode")
        .setContentText("Volume key or earbud tap ends your turn.")
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(open)
        .addAction(0, "Hang up", hangUp)
        .build()
    }
  }
}
