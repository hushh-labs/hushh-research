import UIKit
import Capacitor
import GoogleSignIn

/// UIScene lifecycle for the single-window shell.
///
/// Builds linked against the iOS 27 SDK trap at scene creation when an app
/// has not adopted the scene lifecycle (UIKit's
/// `EvaluateRuntimeIssueForNoSceneLifecycleAdoption`), so this delegate is
/// load-bearing from Xcode 27 on. The window still comes from `Main.storyboard`
/// (named by `UISceneStoryboardFile` in Info.plist); this class only carries
/// the callbacks UIKit routes to the scene instead of the app delegate: the
/// active/background transitions and URL opens. Capacitor's App plugin keeps
/// working unchanged because UIKit still posts the `UIApplication.*Notification`
/// family for a single-scene app.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // A cold start from a URL or a Universal Link arrives here, not in the
        // app delegate's open/continue handlers.
        for context in connectionOptions.urlContexts {
            _ = AppLifecycleHandlers.open(url: context.url, options: context.options)
        }
        for activity in connectionOptions.userActivities {
            _ = AppLifecycleHandlers.continueActivity(activity)
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        AppLifecycleHandlers.didBecomeActive()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        AppLifecycleHandlers.willResignActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        AppLifecycleHandlers.didEnterBackground()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            _ = AppLifecycleHandlers.open(url: context.url, options: context.options)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = AppLifecycleHandlers.continueActivity(userActivity)
    }
}

/// The lifecycle work the shell does, shared by the scene delegate (the path
/// UIKit takes now) and the app delegate (kept so a build without the scene
/// manifest behaves the same).
enum AppLifecycleHandlers {
    static func willResignActive() {
        // Cover the WebView before iOS captures an app-switcher snapshot. The
        // cover remains after resume until JavaScript acknowledges this exact
        // lifecycle generation after the resumed document is ready to be shown.
        HushhSessionPrivacyShield.shared.protectForAppInactive()
    }

    static func didEnterBackground() {
        HushhSessionPrivacyShield.shared.markAppBackgrounded()
    }

    static func didBecomeActive() {
        HushhSessionPrivacyShield.shared.markAppActive()
        (UIApplication.shared.delegate as? AppDelegate)?.logNotificationSettingsOnActivation()
        OneVoiceInvocationCoordinator.shared.publishAvailability(state: "foregrounded")
        OneSystemActionInvocationCoordinator.shared.publishAvailability(state: "foregrounded")
        OneSystemRequestInvocationCoordinator.shared.publishAvailability(state: "foregrounded")
    }

    static func open(url: URL, options: UIScene.OpenURLOptions) -> Bool {
        var legacyOptions: [UIApplication.OpenURLOptionsKey: Any] = [
            .openInPlace: options.openInPlace,
        ]
        if let sourceApplication = options.sourceApplication {
            legacyOptions[.sourceApplication] = sourceApplication
        }
        if let annotation = options.annotation {
            legacyOptions[.annotation] = annotation
        }
        return open(url: url, legacyOptions: legacyOptions)
    }

    static func open(url: URL, legacyOptions: [UIApplication.OpenURLOptionsKey: Any]) -> Bool {
        // Google Sign-In URL callback first; then Capacitor's proxy, which
        // posts capacitorOpenURL so the App plugin can report the open.
        if GIDSignIn.sharedInstance.handle(url) {
            return true
        }
        return ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: legacyOptions)
    }

    static func continueActivity(_ userActivity: NSUserActivity) -> Bool {
        // Universal Links; the proxy posts capacitorOpenUniversalLink.
        ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
