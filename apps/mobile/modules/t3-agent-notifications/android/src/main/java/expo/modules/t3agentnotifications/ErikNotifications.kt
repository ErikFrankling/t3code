package expo.modules.t3agentnotifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Fork: agents' phone notifications (`notify-erik`, Executor `notify`), sent
 * by the fork's server through FCM as data pushes (`t3_kind: "erik_notify"`,
 * apps/server/src/erikPush.ts). Rendered here so they show, and a tap opens
 * the thread, also when the app was not running.
 */
object ErikNotifications {
  private const val TAG = "t3-erik-notify"
  private const val GROUP = "erik-agents"
  const val EXTRA_CODE = "code"
  const val EXTRA_TAG_ID = "notificationId"

  private data class Channel(val id: String, val name: String, val importance: Int)

  private val CHANNELS = mapOf(
    "urgent" to Channel("erik-urgent", "Urgent", NotificationManager.IMPORTANCE_HIGH),
    "high" to Channel("erik-high", "Needs you", NotificationManager.IMPORTANCE_HIGH),
    "code" to Channel("erik-code", "One-time codes", NotificationManager.IMPORTANCE_HIGH),
    "normal" to Channel("erik-normal", "Updates", NotificationManager.IMPORTANCE_DEFAULT),
    "low" to Channel("erik-low", "FYI", NotificationManager.IMPORTANCE_LOW)
  )

  fun receive(context: Context, data: Map<String, String>) {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val kind = data["class"]?.takeIf { it in CHANNELS } ?: "normal"
    val channel = CHANNELS.getValue(kind)
    val path = data["path"]?.takeIf {
      it.startsWith("/threads/") && !it.contains('?') && !it.contains('#')
    }
    // The thread is already on screen: the app shows it, no need to buzz.
    val resumed = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(
      Lifecycle.State.RESUMED
    )
    if (kind != "code" && resumed && path != null && path == AgentNotifications.visibleThread()) {
      return
    }
    channels(context)
    val id = (data["id"] ?: data["sent_at"] ?: "").hashCode()
    val title = data["title"].orEmpty().take(200)
    val body = data["body"].orEmpty().take(4000)
    val code = data["code"]?.takeIf { it.isNotBlank() }?.take(64)
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    val builder = NotificationCompat.Builder(context, channel.id)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_info)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setGroup(GROUP)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPriority(
        when (kind) {
          "low" -> NotificationCompat.PRIORITY_LOW
          "normal" -> NotificationCompat.PRIORITY_DEFAULT
          else -> NotificationCompat.PRIORITY_HIGH
        }
      )
      .setCategory(
        when (kind) {
          "urgent" -> NotificationCompat.CATEGORY_ALARM
          "code" -> NotificationCompat.CATEGORY_MESSAGE
          else -> NotificationCompat.CATEGORY_STATUS
        }
      )
      .setDefaults(if (kind == "low") 0 else Notification.DEFAULT_ALL)
      .setSilent(kind == "low")
      .setContentIntent(contentIntent(context, path, data["url"], id))
    data["sent_at"]?.toLongOrNull()?.let { builder.setWhen(it).setShowWhen(true) }
    if (code != null) {
      val copy = PendingIntent.getBroadcast(
        context,
        id,
        Intent(context, ErikCopyCodeReceiver::class.java)
          .putExtra(EXTRA_CODE, code)
          .putExtra(EXTRA_TAG_ID, id),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      builder.addAction(0, "Copy code", copy)
      // Codes expire: drop the notification once FCM's TTL has passed.
      builder.setTimeoutAfter(10 * 60 * 1000L)
    }
    context.getSystemService(NotificationManager::class.java).notify(TAG, id, builder.build())
  }

  /**
   * Release pings: CI sends a content-free `t3_kind: "erik_update"` to this
   * topic after publishing. Topics have no access control, so nothing else
   * may ever be sent on it.
   */
  private const val UPDATE_TOPIC = "erik-updates"

  fun subscribeToUpdates() {
    try {
      FirebaseMessaging.getInstance().subscribeToTopic(UPDATE_TOPIC)
    } catch (_: IllegalStateException) {
      // Built without google-services.json: no Firebase, nothing to subscribe.
    }
  }

  /** Hands the ping to the self-updater (its own receiver); fields are ignored. */
  fun requestUpdateCheck(context: Context) {
    context.sendBroadcast(
      Intent("${context.packageName}.T3_SELF_UPDATE_CHECK").setPackage(context.packageName)
    )
  }

  fun cancel(context: Context, id: Int) {
    context.getSystemService(NotificationManager::class.java).cancel(TAG, id)
  }

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannelGroup(NotificationChannelGroup(GROUP, "From your agents"))
    manager.createNotificationChannels(
      CHANNELS.values.map {
        NotificationChannel(it.id, it.name, it.importance).apply { group = GROUP }
      }
    )
  }

  /** The URL scheme of this build variant (app.config.ts). */
  private fun scheme(context: Context): String = when {
    context.packageName.endsWith(".preview") -> "t3code-preview"
    context.packageName.endsWith(".dev") -> "t3code-dev"
    else -> "t3code"
  }

  private fun contentIntent(context: Context, path: String?, url: String?, id: Int): PendingIntent? {
    val intent = if (path == null && url != null &&
      (url.startsWith("https://") || url.startsWith("http://"))
    ) {
      Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    } else {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: return null
      launch.setAction(Intent.ACTION_VIEW)
        .setData(Uri.parse("${scheme(context)}:/${path ?: "/"}"))
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}

class ErikCopyCodeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val code = intent.getStringExtra(ErikNotifications.EXTRA_CODE) ?: return
    context.getSystemService(ClipboardManager::class.java)
      .setPrimaryClip(ClipData.newPlainText("One-time code", code))
    // Android 13+ shows its own clipboard confirmation.
    if (Build.VERSION.SDK_INT < 33) {
      Toast.makeText(context, "Code copied", Toast.LENGTH_SHORT).show()
    }
    ErikNotifications.cancel(context, intent.getIntExtra(ErikNotifications.EXTRA_TAG_ID, 0))
  }
}
