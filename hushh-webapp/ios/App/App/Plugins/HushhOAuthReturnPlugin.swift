import Capacitor
import FirebaseAuth
import Foundation
import UIKit
import WebKit

enum ScopeCommerceSandboxOAuthPolicy {
    static let bundleID = "com.hushh.app.scopecommerce.sandbox"
    static func admits(_ url: URL, pin: String?, bundleID: String?, isDebug: Bool) -> Bool {
        guard isDebug, bundleID == Self.bundleID, let pin,
              pin.range(of: "^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+run\\.app$", options: .regularExpression) != nil,
              let origin = URL(string: pin), url.scheme == "https", url.host == origin.host,
              url.port == nil, url.user == nil, url.password == nil, url.fragment == nil,
              URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == "/one/profile/connectors/oauth/return" else { return false }
        return true
    }
}

/// The provider OAuth flows (Plaid, Google, Gmail) end with the page
/// navigating the WebView's top frame to the app's https return route. That
/// host is not the app's origin, so Capacitor's navigation policy hands the
/// URL to Safari, where no session exists and the flow dies (measured on the
/// phone with a real Chase connection: the link token was minted, no exchange
/// ever arrived). A Universal Link never fires for a redirect chain that ends
/// inside a WebView. This plugin catches that one navigation, cancels it, and
/// delivers the URL to the running app the way a Universal Link would (the
/// App plugin's `appUrlOpen`), so the deep-link return routes to the return
/// page with the vault and the resume session intact. Only the app's own
/// hosts and only the return paths; everything else keeps Capacitor's policy.
@objc(HushhOAuthReturnPlugin)
public class HushhOAuthReturnPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhOAuthReturnPlugin"
    public let jsName = "HushhOAuthReturn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAuthorization", returnType: CAPPluginReturnPromise)
    ]

    private static let hosts: Set<String> = ["one.hushh.ai", "uat.one.hushh.ai", "dev.one.hushh.ai"]
    private static let returnPathSuffix = "/oauth/return"
    private static let customReturnPath = "/one/profile/connectors/oauth/return"

    private func admitsReturn(_ url: URL) -> Bool {
        if Bundle.main.bundleIdentifier == ScopeCommerceSandboxOAuthPolicy.bundleID {
            #if DEBUG
            return ScopeCommerceSandboxOAuthPolicy.admits(url,
                pin: bridge?.config.getPluginConfig(jsName).getString("sandboxFrontendOrigin"),
                bundleID: Bundle.main.bundleIdentifier, isDebug: true)
            #else
            return false
            #endif
        }
        return url.host.map { Self.hosts.contains($0.lowercased()) } ?? false
    }

    /// The server owns PKCE, the exact callback, and code exchange. Native
    /// opens only a user-tapped HTTPS authorization in the system browser;
    /// it never receives a provider token or claims that connection succeeded.
    @objc func openAuthorization(_ call: CAPPluginCall) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.openAuthorization(call) }
            return
        }
        guard let rawURL = call.getString("authorizeUrl"), rawURL.count <= 16_000,
              let authorizeURL = URL(string: rawURL), authorizeURL.scheme == "https",
              authorizeURL.host != nil, authorizeURL.user == nil,
              authorizeURL.password == nil, authorizeURL.fragment == nil,
              let rawReturn = call.getString("redirectUri"), rawReturn.count <= 2_048,
              let returnURL = URL(string: rawReturn), returnURL.scheme == "https",
              admitsReturn(returnURL),
              returnURL.path == Self.customReturnPath,
              returnURL.user == nil, returnURL.password == nil,
              returnURL.port == nil, returnURL.query == nil, returnURL.fragment == nil,
              let attemptID = call.getString("attemptId"),
              attemptID.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let expectedUserID = call.getString("expectedUserId"),
              Auth.auth().currentUser?.uid == expectedUserID else {
            call.reject("Connector sign-in is unavailable in this session.", "connector_oauth_unavailable")
            return
        }
        UIApplication.shared.open(authorizeURL, options: [:]) { opened in
            if opened { call.resolve() }
            else { call.reject("Could not open connector sign-in.", "connector_oauth_open_failed") }
        }
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url,
              url.scheme?.lowercased() == "https",
              admitsReturn(url),
              url.path.hasSuffix(Self.returnPathSuffix) else {
            return nil
        }
        let topFrame = navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true
        guard topFrame else { return nil }
        NotificationCenter.default.post(name: .capacitorOpenURL, object: [
            "url": url,
            "options": [UIApplication.OpenURLOptionsKey: Any]()
        ])
        return true
    }
}
