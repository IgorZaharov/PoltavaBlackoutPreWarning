package ua.blackout.prewarning.worker

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import ua.blackout.prewarning.data.repository.OutageRepository
import ua.blackout.prewarning.data.repository.SettingsRepository
import ua.blackout.prewarning.notification.AlarmScheduler
import ua.blackout.prewarning.widget.BlackoutGlanceWidget
import java.util.concurrent.TimeUnit

class ScheduleSyncWorker(
    private val context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {

    override suspend fun doWork(): Result {
        val appContext = context.applicationContext
        try {
            val settingsRepo = SettingsRepository(appContext)

            // The queue of every address is re-read from POE inside the refresh (per-house status, E4),
            // so a house that gets a queue later, or changes it, is updated without a separate check.
            // Each source is isolated inside OutageRepository: a failing site never stops the other one,
            // and a failure is never treated as "no outage".
            try {
                OutageRepository(appContext).refresh(settingsRepo.getSettings())
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }

            try {
                if (BlackoutGlanceWidget.hasActiveWidgets(appContext)) {
                    BlackoutGlanceWidget.syncAllWidgets(appContext)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            return Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()
        } finally {
            // Alarms are planned from the latest stored state even when a source failed above
            try {
                AlarmScheduler.syncAlarms(appContext)
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        const val WORK_NAME = "ScheduleSyncWorker"
        private const val MAX_ATTEMPTS = 3

        fun schedulePeriodicWork(
            context: Context,
            policy: ExistingPeriodicWorkPolicy = ExistingPeriodicWorkPolicy.KEEP
        ) {
            val appContext = context.applicationContext
            val settings = SettingsRepository(appContext).getSettings()
            // WorkManager never runs periodic work more often than every 15 minutes
            val intervalMinutes = settings.refreshIntervalMinutes.coerceAtLeast(15L)

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val syncRequest = PeriodicWorkRequestBuilder<ScheduleSyncWorker>(intervalMinutes, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(appContext).enqueueUniquePeriodicWork(
                WORK_NAME,
                policy,
                syncRequest
            )
        }
    }
}
