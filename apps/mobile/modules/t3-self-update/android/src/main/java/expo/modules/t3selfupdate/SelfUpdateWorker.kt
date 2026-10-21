package expo.modules.t3selfupdate

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

class SelfUpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val outcome = SelfUpdater.check(applicationContext, installEvenIfForeground = false)
    Log.i("T3SelfUpdate", "background check: $outcome")
    return Result.success()
  }
}
