import Capacitor
import Foundation
import WebKit

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
    public let pluginMethods: [CAPPluginMethod] = []

    private static let hosts: Set<String> = ["one.hushh.ai", "uat.one.hushh.ai", "dev.one.hushh.ai"]
    private static let returnPathSuffix = "/oauth/return"

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url,
              url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), Self.hosts.contains(host),
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
