import UIKit
import Capacitor
import FirebaseCore
import FirebaseAuth
import FirebaseMessaging
import GoogleSignIn
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private let nativeTestConfig = NativeTestConfiguration()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Ensure Firebase is initialized once for native plugins and auth flows.
        if FirebaseApp.app() == nil {
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

        // Configure the delegate so notification presentation and tap handling work
        // after the app explicitly requests permission from the notification init flow.
        UNUserNotificationCenter.current().delegate = self
        Messaging.messaging().delegate = self

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
    }
    
    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
        print("❌ [AppDelegate] Failed to register for remote notifications: \(error)")
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable : Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationCenter.default.post(
            name: Notification.Name("didReceiveRemoteNotification"),
            object: completionHandler,
            userInfo: userInfo
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

// MARK: - UNUserNotificationCenterDelegate
extension AppDelegate: UNUserNotificationCenterDelegate {
    // Handle foreground notifications (app is open)
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let userInfo = notification.request.content.userInfo
        print("📬 [AppDelegate] Foreground notification received: \(userInfo)")
        // Present as a real system notification even while the app is active.
        completionHandler([.banner, .list, .sound, .badge])
    }
    
    // Handle notification taps
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        print("👆 [AppDelegate] Notification tapped")
        
        let userInfo = response.notification.request.content.userInfo
        print("📦 [AppDelegate] Notification data: \(userInfo)")
        
        // The Capacitor FCM plugin will handle the navigation
        // via the notificationActionPerformed listener
        
        completionHandler()
    }
}

// MARK: - MessagingDelegate
extension AppDelegate: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        if let fcmToken, !fcmToken.isEmpty {
            print("✅ [AppDelegate] Firebase Messaging registration token refreshed: \(fcmToken.prefix(24))...")
        } else {
            print("⚠️ [AppDelegate] Firebase Messaging registration token missing")
        }
    }
}
