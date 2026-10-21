package expo.modules.t3selfupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * CI pings the `erik-updates` FCM topic after every release; the agent
 * notifications module turns that ping into this package-local broadcast. The
 * ping carries nothing, so this only schedules the same check the app runs
 * when it leaves the screen: download a newer APK and install it if the app
 * is not in use.
 */
class UpdatePingReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    Log.i("T3SelfUpdate", "release ping")
    SelfUpdater.checkAfterBackgrounding(context.applicationContext)
  }
}
