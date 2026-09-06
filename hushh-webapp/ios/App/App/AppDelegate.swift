import UIKit
import Capacitor
import FirebaseCore
import FirebaseAuth
import FirebaseMessaging
import GoogleSignIn
import UserNotifications
import AVFoundation
#if canImport(AppIntents)
import AppIntents
#endif

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    private static let consentNotificationCategory = "CONSENT_REQUEST"
    private static let consentReviewAction = "CONSENT_REVIEW"
    private static let consentApproveAction = "CONSENT_APPROVE"
    private static let consentDenyAction = "CONSENT_DENY"
    private static let emergencySmsNotificationCategory = "ONE_LOCATION_SMS_EMERGENCY"
    private static let emergencySmsOpenAction = "ONE_LOCATION_SMS_OPEN"
    private static let emergencySmsSound = "one_location_sms_alarm.wav"

    var window: UIWindow?
    private let nativeTestConfig = NativeTestConfiguration()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
#if canImport(AppIntents)
        if #available(iOS 16.0, *) {
            HusshOneAppShortcuts.updateAppShortcutParameters()
        }
#endif
        // Ensure Firebase is initialized once for native plugins and auth flows.
        // `FirebaseApp.app()` logs an error when no default app exists, even
        // when that is the normal first-launch state. Inspect the registry so
        // cold starts stay clean before configuring the default app.
        if FirebaseApp.allApps?.isEmpty != false {
            if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
                FirebaseApp.configure()
                print("✅ [AppDelegate] Firebase configured")
            } else {
                print("⚠️ [AppDelegate] GoogleService-Info.plist missing; Firebase not configured")
            }
        } else {
            print("ℹ️ [AppDelegate] Firebase already initialized")
        }

        NativeTestResetter.resetAppStateIfNeeded(configuration: nativeTestConfig)

        prepareEmergencySmsSound()
        registerNotificationCategories()
        Messaging.messaging().delegate = self
        logNotificationSettings(context: "didFinishLaunching")

        return true
    }
    
    // MARK: - Remote Notifications
    
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard FirebaseApp.app() != nil else {
            print("⚠️ [AppDelegate] APNs token received before Firebase initialization")
            return
        }
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
        // Pass APNs token to Firebase Messaging
        Messaging.messaging().apnsToken = deviceToken
        print("✅ [AppDelegate] APNs token registered with Firebase Messaging")
        logNotificationSettings(context: "didRegisterForRemoteNotifications")
    }
    
    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
        print("❌ [AppDelegate] Failed to register for remote notifications: \(error)")
        logNotificationSettings(context: "didFailToRegisterForRemoteNotifications")
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable : Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationCenter.default.post(
            name: Notification.Name("didReceiveRemoteNotification"),
            object: completionHandler,
            userInfo: userInfo
        )
        print(
            "📩 [AppDelegate] Remote notification received while appState=\(application.applicationState.debugLabel)"
        )
        completionHandler(.newData)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        logNotificationSettings(context: "applicationDidBecomeActive")
        OneVoiceInvocationCoordinator.shared.publishAvailability(state: "foregrounded")
        OneSystemActionInvocationCoordinator.shared.publishAvailability(state: "foregrounded")
        OneSystemRequestInvocationCoordinator.shared.publishAvailability(state: "foregrounded")
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Handle Google Sign-In URL callback
        if GIDSignIn.sharedInstance.handle(url) {
            return true
        }
        
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// MARK: - MessagingDelegate
extension AppDelegate: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        if let fcmToken, !fcmToken.isEmpty {
            print("✅ [AppDelegate] Firebase Messaging registration token refreshed")
            logNotificationSettings(context: "didReceiveRegistrationToken")
        } else {
            print("⚠️ [AppDelegate] Firebase Messaging registration token missing")
        }
    }
}

private extension AppDelegate {
    func registerNotificationCategories() {
        let reviewAction = UNNotificationAction(
            identifier: Self.consentReviewAction,
            title: "Review",
            options: [.foreground]
        )
        let approveAction = UNNotificationAction(
            identifier: Self.consentApproveAction,
            title: "Approve",
            options: [.foreground]
        )
        let denyAction = UNNotificationAction(
            identifier: Self.consentDenyAction,
            title: "Deny",
            options: [.foreground, .destructive]
        )
        let consentCategory = UNNotificationCategory(
            identifier: Self.consentNotificationCategory,
            actions: [reviewAction, approveAction, denyAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        let emergencyOpenAction = UNNotificationAction(
            identifier: Self.emergencySmsOpenAction,
            title: "Open live location",
            options: [.foreground]
        )
        let emergencyCategory = UNNotificationCategory(
            identifier: Self.emergencySmsNotificationCategory,
            actions: [emergencyOpenAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        UNUserNotificationCenter.current().setNotificationCategories([
            consentCategory,
            emergencyCategory,
        ])
        print(
            "✅ [AppDelegate] Registered notification categories: \(Self.consentNotificationCategory), \(Self.emergencySmsNotificationCategory)"
        )
    }

    func prepareEmergencySmsSound() {
        do {
            let fileManager = FileManager.default
            guard let libraryDirectory = fileManager.urls(
                for: .libraryDirectory,
                in: .userDomainMask
            ).first else {
                return
            }
            let soundsDirectory = libraryDirectory.appendingPathComponent(
                "Sounds",
                isDirectory: true
            )
            try fileManager.createDirectory(
                at: soundsDirectory,
                withIntermediateDirectories: true
            )
            let soundURL = soundsDirectory.appendingPathComponent(Self.emergencySmsSound)
            if fileManager.fileExists(atPath: soundURL.path) {
                return
            }

            let sampleRate = 44_100.0
            let duration = 0.94
            guard
                let format = AVAudioFormat(
                    commonFormat: .pcmFormatInt16,
                    sampleRate: sampleRate,
                    channels: 1,
                    interleaved: false
                ),
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: format,
                    frameCapacity: AVAudioFrameCount(sampleRate * duration)
                ),
                let samples = buffer.int16ChannelData?[0]
            else {
                return
            }

            buffer.frameLength = buffer.frameCapacity
            var phase = 0.0
            for frame in 0..<Int(buffer.frameLength) {
                let time = Double(frame) / sampleRate
                let pulseOffset = time.truncatingRemainder(dividingBy: 0.34)
                let isPulse = pulseOffset < 0.24
                let frequency = 980.0 - (360.0 * min(pulseOffset / 0.24, 1.0))
                phase += (2.0 * Double.pi * frequency) / sampleRate
                let envelope = isPulse
                    ? sin(Double.pi * pulseOffset / 0.24) * 0.55
                    : 0.0
                samples[frame] = Int16(
                    max(-1.0, min(1.0, sin(phase) * envelope)) * Double(Int16.max)
                )
            }

            let audioFile = try AVAudioFile(
                forWriting: soundURL,
                settings: format.settings,
                commonFormat: .pcmFormatInt16,
                interleaved: false
            )
            try audioFile.write(from: buffer)
            print("✅ [AppDelegate] Emergency SMS notification sound ready")
        } catch {
            print("⚠️ [AppDelegate] Emergency SMS sound setup failed: \(error.localizedDescription)")
        }
    }

    func logNotificationSettings(context: String) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            print(
                "🔔 [AppDelegate] Notification settings (\(context)): auth=\(settings.authorizationStatus.debugLabel) alert=\(settings.alertSetting.debugLabel) badge=\(settings.badgeSetting.debugLabel) sound=\(settings.soundSetting.debugLabel) center=\(settings.notificationCenterSetting.debugLabel) lock=\(settings.lockScreenSetting.debugLabel) banner=\(settings.alertSetting.debugLabel)"
            )
        }
    }
}

private extension UIApplication.State {
    var debugLabel: String {
        switch self {
        case .active:
            return "active"
        case .inactive:
            return "inactive"
        case .background:
            return "background"
        @unknown default:
            return "unknown"
        }
    }
}

private extension UNAuthorizationStatus {
    var debugLabel: String {
        switch self {
        case .authorized:
            return "authorized"
        case .denied:
            return "denied"
        case .ephemeral:
            return "ephemeral"
        case .notDetermined:
            return "not_determined"
        case .provisional:
            return "provisional"
        @unknown default:
            return "unknown"
        }
    }
}

private extension UNNotificationSetting {
    var debugLabel: String {
        switch self {
        case .enabled:
            return "enabled"
        case .disabled:
            return "disabled"
        case .notSupported:
            return "not_supported"
        @unknown default:
            return "unknown"
        }
    }
}
