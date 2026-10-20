package expo.modules.t3selfupdate

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class SelfUpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    SelfUpdater.check(applicationContext, installEvenIfForeground = false)
    return Result.success()
  }
}
