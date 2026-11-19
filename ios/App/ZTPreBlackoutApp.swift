import SwiftUI
import UserNotifications

@main
struct ZTPreBlackoutApp: App {
    /// CI design gallery (milestone M3), only when launched with `-ZTGallery <page>`.
    private let gallery = DesignGallery.fromLaunchArguments()

    init() {
        NetworkProbe.start()
        // the bundled POE directory (about 1 MB of JSON) is parsed off the main thread
        Task.detached(priority: .utility) { PoeAddressLookup.initialize() }
        UNUserNotificationCenter.current().delegate = ForegroundNotificationDelegate.shared
        AppModel.applyLaunchSeed()
        // BackgroundRefresh.schedule() runs once the scene is active: iOS asserts on a request submitted
        // before `.backgroundTask` below has registered its handler
    }

    var body: some Scene {
        WindowGroup {
            if let gallery {
                gallery
            } else {
                RootView()
            }
        }
        // iOS runs it when it sees fit (BackgroundRefresh.swift, plan milestone M5)
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            await BackgroundRefresh.run()
        }
    }
}
