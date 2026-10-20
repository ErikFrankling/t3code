package expo.modules.t3selfupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
    Log.i("T3SelfUpdate", "install status $status ${message.orEmpty()}")
    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        SelfUpdater.prefs(context).edit()
          .putString("lastError", "waiting for confirmation")
          .putBoolean("awaitingConfirmation", true)
          .apply()
        if (confirm != null) SelfUpdater.requestConfirmation(context, confirm)
      }
      // On success Android has already replaced this process.
      PackageInstaller.STATUS_SUCCESS -> Unit
      else ->
        SelfUpdater.prefs(context).edit()
          .putString("lastError", "install failed ($status): ${message.orEmpty()}")
          .remove("installingVersionCode")
          .apply()
    }
  }
}
