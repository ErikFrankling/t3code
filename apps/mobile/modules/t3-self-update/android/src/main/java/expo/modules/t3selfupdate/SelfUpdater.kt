package expo.modules.t3selfupdate

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Installs new builds of Erik's fork without a tap. CI publishes an index
 * with the newest APK; this downloads it, checks it, and commits a
 * PackageInstaller session with USER_ACTION_NOT_REQUIRED. Android 12+ lets an
 * app update itself that way. Android still asks once when the app was first
 * installed by another installer that owns its updates (Obtainium on 14+) or
 * when "Install unknown apps" is not allowed yet; that confirmation arrives as
 * STATUS_PENDING_USER_ACTION and is shown or posted as a notification.
 */
object SelfUpdater {
  private const val TAG = "T3SelfUpdate"
  private const val PREFS = "t3_self_update"
  private const val PERIODIC_WORK = "t3-self-update"
  private const val CHANNEL = "t3-app-updates"
  const val NOTIFICATION_ID = 0x5e1f

  data class Release(
    val versionCode: Long,
    val versionName: String,
    val url: String,
    val sha256: String,
  )

  private val lock = Any()

  fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun configure(context: Context, indexUrl: String) {
    prefs(context).edit().putString("indexUrl", indexUrl).apply()
    val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    // 15 minutes is WorkManager's floor; CI pushes and app resumes check sooner.
    val periodic = PeriodicWorkRequestBuilder<SelfUpdateWorker>(15, TimeUnit.MINUTES)
      .setConstraints(constraints)
      .build()
    WorkManager.getInstance(context)
      .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, periodic)
  }

  fun installedVersionCode(context: Context): Long {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    @Suppress("DEPRECATION")
    return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
  }

  /** The app is on screen or holds a foreground service (voice mode): do not restart it. */
  fun isInForeground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
  }

  /**
   * Returns "disabled", "current", "downloaded" (waiting for the app to leave
   * the screen), "installing" or "error: ...".
   */
  fun check(context: Context, installEvenIfForeground: Boolean): String = synchronized(lock) {
    val indexUrl = prefs(context).getString("indexUrl", null) ?: return "disabled"
    prefs(context).edit().putLong("lastCheckAt", System.currentTimeMillis()).apply()
    try {
      val release = fetchLatest(indexUrl) ?: return "current"
      if (release.versionCode <= installedVersionCode(context)) {
        apkDir(context).listFiles()?.forEach { it.delete() }
        return "current"
      }
      val apk = download(context, release)
      prefs(context).edit().putLong("downloadedVersionCode", release.versionCode).apply()
      if (!installEvenIfForeground && isInForeground()) return "downloaded"
      // Give a running install time to finish, and a pending confirmation an
      // hour before posting it again.
      val waitMs = if (prefs(context).getBoolean("awaitingConfirmation", false)) 3_600_000 else 60_000
      if (prefs(context).getLong("installingVersionCode", 0) == release.versionCode &&
        System.currentTimeMillis() - prefs(context).getLong("installingAt", 0) < waitMs
      ) {
        return "installing"
      }
      install(context, apk, release)
      "installing"
    } catch (error: Exception) {
      Log.w(TAG, "update check failed", error)
      val message = "error: ${error.message ?: error.javaClass.simpleName}"
      prefs(context).edit().putString("lastError", message).apply()
      message
    }
  }

  private fun fetchLatest(indexUrl: String): Release? {
    val connection = URL(indexUrl).openConnection() as HttpURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 15_000
    connection.setRequestProperty("Cache-Control", "no-cache")
    try {
      if (connection.responseCode != 200) throw IllegalStateException("index HTTP ${connection.responseCode}")
      val body = connection.inputStream.bufferedReader().use { it.readText() }
      val apk = JSONObject(body).optJSONObject("apk") ?: return null
      return Release(
        versionCode = apk.getLong("versionCode"),
        versionName = apk.optString("versionName"),
        url = apk.getString("url"),
        sha256 = apk.getString("sha256").lowercase(),
      )
    } finally {
      connection.disconnect()
    }
  }

  private fun apkDir(context: Context) = File(context.noBackupFilesDir, "self-update").apply { mkdirs() }

  private fun download(context: Context, release: Release): File {
    val target = File(apkDir(context), "${release.versionCode}.apk")
    if (target.exists() && sha256(target) == release.sha256) return target
    apkDir(context).listFiles()?.forEach { it.delete() }
    val partial = File(apkDir(context), "${release.versionCode}.part")
    val connection = URL(release.url).openConnection() as HttpURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 60_000
    connection.instanceFollowRedirects = true
    try {
      if (connection.responseCode != 200) throw IllegalStateException("APK HTTP ${connection.responseCode}")
      connection.inputStream.use { input -> partial.outputStream().use { input.copyTo(it, 1 shl 16) } }
    } finally {
      connection.disconnect()
    }
    val actual = sha256(partial)
    if (actual != release.sha256) {
      partial.delete()
      throw IllegalStateException("APK checksum mismatch")
    }
    val archive = context.packageManager.getPackageArchiveInfo(partial.path, 0)
      ?: throw IllegalStateException("downloaded file is not an APK")
    if (archive.packageName != context.packageName) {
      partial.delete()
      throw IllegalStateException("APK is for ${archive.packageName}")
    }
    partial.renameTo(target)
    return target
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(1 shl 16)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun install(context: Context, apk: File, release: Release) {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(context.packageName)
    params.setSize(apk.length())
    if (Build.VERSION.SDK_INT >= 31) {
      params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }
    val sessionId = installer.createSession(params)
    installer.openSession(sessionId).use { session ->
      apk.inputStream().use { input ->
        session.openWrite("base.apk", 0, apk.length()).use { output ->
          input.copyTo(output, 1 shl 16)
          session.fsync(output)
        }
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
      val callback = PendingIntent.getBroadcast(
        context,
        sessionId,
        Intent(context, InstallResultReceiver::class.java).setPackage(context.packageName),
        flags,
      )
      prefs(context).edit()
        .putLong("installingVersionCode", release.versionCode)
        .putLong("installingAt", System.currentTimeMillis())
        .putBoolean("awaitingConfirmation", false)
        .remove("lastError")
        .apply()
      Log.i(TAG, "installing ${release.versionName} (${release.versionCode})")
      session.commit(callback.intentSender)
    }
  }

  /** Android wants a confirmation once: show it now or leave a notification. */
  fun requestConfirmation(context: Context, confirm: Intent) {
    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (isInForeground()) {
      try {
        context.startActivity(confirm)
        return
      } catch (error: Exception) {
        Log.w(TAG, "could not show the install confirmation", error)
      }
    }
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT),
      )
    }
    val pending = PendingIntent.getActivity(
      context,
      NOTIFICATION_ID,
      confirm,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      .takeIf { it != 0 } ?: context.applicationInfo.icon
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      android.app.Notification.Builder(context, CHANNEL)
    } else {
      android.app.Notification.Builder(context)
    }
    val notification = builder
      .setSmallIcon(icon)
      .setContentTitle("T3 Code update ready")
      .setContentText("Tap once to allow it. Later updates install by themselves.")
      .setContentIntent(pending)
      .setAutoCancel(true)
      .build()
    if (Build.VERSION.SDK_INT < 33 ||
      context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      manager.notify(NOTIFICATION_ID, notification)
    }
  }
}
