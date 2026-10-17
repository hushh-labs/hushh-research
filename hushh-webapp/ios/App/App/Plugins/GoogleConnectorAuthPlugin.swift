import AuthenticationServices
import Capacitor
import FirebaseAuth
import UIKit

/// Owner-local installed-client PKCE. No provider exchange or token persistence.
@objc(GoogleConnectorAuthPlugin)
public class GoogleConnectorAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "GoogleConnectorAuthPlugin"
    public let jsName = "GoogleConnectorAuth"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]
    private var session: ASWebAuthenticationSession?
    private var pending: CAPPluginCall?
    private var timeout: DispatchWorkItem?

    @objc func open(_ call: CAPPluginCall) {
        guard Thread.isMainThread else { DispatchQueue.main.async { self.open(call) }; return }
        guard pending == nil else { call.reject("Sign-in is already open.", "SIGN_IN_BUSY"); return }
        guard let owner = call.getString("expectedUserId"), !owner.isEmpty,
              Auth.auth().currentUser?.uid == owner,
              let raw = call.getString("authorizationUrl"), raw.count <= 16_000,
              let url = URL(string: raw), url.scheme == "https", url.host == "accounts.google.com",
              url.path == "/o/oauth2/v2/auth", url.user == nil, url.password == nil,
              url.port == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems,
              Set(items.map(\.name)).count == items.count,
              let client = items.first(where: { $0.name == "client_id" })?.value,
              client.range(of: "^[0-9]{4,32}-[a-z0-9]{8,64}\\.apps\\.googleusercontent\\.com$", options: .regularExpression) != nil,
              let redirect = call.getString("redirectUri"),
              redirect == "com.googleusercontent.apps.\(client.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")):/oauth2redirect",
              items.first(where: { $0.name == "redirect_uri" })?.value == redirect,
              items.first(where: { $0.name == "response_type" })?.value == "code",
              items.first(where: { $0.name == "code_challenge_method" })?.value == "S256",
              let challenge = items.first(where: { $0.name == "code_challenge" })?.value,
              challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let state = items.first(where: { $0.name == "state" })?.value,
              state.range(of: "^[A-Za-z0-9_-]{22,128}$", options: .regularExpression) != nil,
              !items.contains(where: { $0.name == "client_secret" }),
              let callbackScheme = URL(string: redirect)?.scheme else {
            call.reject("Sign-in could not be opened.", "SIGN_IN_INCOMPLETE"); return
        }
        let registeredSchemes = (Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? [])
            .flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        guard registeredSchemes.contains(callbackScheme) else {
            call.reject("This Google client is not registered in this app build.", "NATIVE_CLIENT_NOT_CONFIGURED"); return
        }
        pending = call
        let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callback, error in
            DispatchQueue.main.async {
                guard let self, self.pending === call else { return }
                guard Auth.auth().currentUser?.uid == owner else { self.finish(error: "POD_OWNER_CHANGED"); return }
                if error != nil { self.finish(error: "SIGN_IN_CANCELLED"); return }
                guard let callback, var result = URLComponents(url: callback, resolvingAgainstBaseURL: false),
                      result.queryItems?.filter({ $0.name == "state" }).map(\.value) == [state] else {
                    self.finish(error: "SIGN_IN_INCOMPLETE"); return
                }
                result.query = nil
                guard result.string == redirect, callback.fragment == nil else {
                    self.finish(error: "SIGN_IN_INCOMPLETE"); return
                }
                self.finish(redirect: callback.absoluteString)
            }
        }
        session = auth
        auth.presentationContextProvider = self
        auth.prefersEphemeralWebBrowserSession = true
        let deadline = DispatchWorkItem { [weak self] in
            self?.session?.cancel(); self?.finish(error: "SIGN_IN_CANCELLED")
        }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 300, execute: deadline)
        if !auth.start() { finish(error: "SIGN_IN_INCOMPLETE") }
    }

    private func finish(redirect: String? = nil, error: String? = nil) {
        guard let call = pending else { return }
        pending = nil; session = nil; timeout?.cancel(); timeout = nil
        if let redirect { call.resolve(["redirectUrl": redirect]) }
        else { call.reject("Google sign-in did not finish.", error ?? "SIGN_IN_INCOMPLETE") }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
