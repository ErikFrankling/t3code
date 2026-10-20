package expo.modules.t3selfupdate

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3SelfUpdateModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext) { "React context is gone" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("T3SelfUpdate")

    Function("configure") { indexUrl: String -> SelfUpdater.configure(context, indexUrl) }

    // Download a newer APK if there is one; install it only when the app is
    // off screen, or right away when `installNow` (the app just went to the
    // background and saved its state).
    AsyncFunction("check") { installNow: Boolean ->
      SelfUpdater.check(context, installEvenIfForeground = installNow)
    }

    Function("status") {
      val prefs = SelfUpdater.prefs(context)
      mapOf(
        "installedVersionCode" to SelfUpdater.installedVersionCode(context).toDouble(),
        "downloadedVersionCode" to prefs.getLong("downloadedVersionCode", 0).toDouble(),
        "lastCheckAt" to prefs.getLong("lastCheckAt", 0).toDouble(),
        "lastError" to prefs.getString("lastError", null),
      )
    }
  }
}
