import BackgroundTasks
import Foundation
import WidgetKit

/// Background refresh (port of Android `worker/ScheduleSyncWorker.kt`, plan milestone M5). iOS decides
/// when a `BGAppRefreshTask` runs (minutes to hours, or not at all), so emergency alerts in the
/// background are best effort (spec/NOTIFICATIONS.md 3); the app also refreshes on every foreground.
/// Planned pre-warnings do not depend on it: they are scheduled ahead as local notifications.
enum BackgroundRefresh {
    /// Listed in `BGTaskSchedulerPermittedIdentifiers` (ios/App/Info.plist).
    static let identifier = "ua.blackout.prewarning.poltava.sync"

    /// Asks iOS for the next run, no earlier than one refresh interval from now (at least 15 minutes,
    /// like WorkManager's floor on Android). Called on launch, when the app goes to the background and
    /// at the start of every run.
    static func schedule() {
        let minutes = max(15, SettingsRepository.shared.getSettings().refreshIntervalMinutes)
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: TimeInterval(minutes * 60))
        try? BGTaskScheduler.shared.submit(request)
    }

    /// One run: re-check a saved house that has no queue yet, refresh both sources, post the emergency
    /// events, re-plan the pre-warnings and redraw the widgets. A failing source keeps its old data and
    /// the warnings are planned from the latest stored state anyway.
    static func run() async {
        schedule()
        PoeAddressLookup.initialize()

        // The queue of every address is re-read from POE inside the refresh (per-house status, E4, written
        // back through the subscription store), so a house that gets a queue later, or changes it, is updated
        // without a separate check, as Android `ScheduleSyncWorker` does since P3; a second E4 request per
        // run would only cost time and traffic in the short background window.
        if !Task.isCancelled {
            let outcome = await OutageRepository.shared.refresh(SettingsRepository.shared.getSettings(),
                                                                widgetItemIds: await WidgetBindings.shownItemIds())
            await NotificationSync.shared.deliverEmergency(outcome.batches)
        }
        await NotificationSync.shared.syncPlanned()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
