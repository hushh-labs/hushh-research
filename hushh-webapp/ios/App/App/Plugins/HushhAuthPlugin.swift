import UIKit
import Capacitor
import FirebaseCore
import FirebaseAuth
import GoogleSignIn
import AuthenticationServices
import CryptoKit

/// Metadata-only, single-use callback fence. No credential or draft is stored.
final class GoogleIdentityReauthenticationFence {
    enum Claim { case accepted, ignored, stale }
    let expectedUserID: String
    let deadline: TimeInterval
    private(set) var phase = 0
    private(set) var settled = false
    private(set) var providerOutstanding = true
    var canRelease: Bool { settled && !providerOutstanding }

    init(expectedUserID: String, now: TimeInterval) {
        self.expectedUserID = expectedUserID
        deadline = now + 120
    }

    func claim(phase expectedPhase: Int, userID: String?, sameSession: Bool, now: TimeInterval) -> Claim {
        guard !settled, phase == expectedPhase else { return .ignored }
        guard sameSession, userID == expectedUserID, now < deadline else { return .stale }
        phase += 1
        return .accepted
    }

    @discardableResult func settle() -> Bool {
        guard !settled else { return false }
        settled = true
        return true
    }

    @discardableResult func drainProvider() -> Bool {
        guard providerOutstanding else { return false }
        providerOutstanding = false
        return true
    }
}

/// Single-use metadata fence for the Drive system-browser return. It contains
/// no provider credential, OAuth code, state, or persisted attempt material.
final class NativeDriveAuthorizationFence {
    enum Claim { case accepted, ignored, stale }
    let expectedUserID: String
    let expectedAttemptID: String
    let deadline: TimeInterval
    private(set) var settled = false
    private(set) var providerOutstanding = true
    var canRelease: Bool { settled && !providerOutstanding }

    init(expectedUserID: String, expectedAttemptID: String, expiresAtMilliseconds: Double) {
        self.expectedUserID = expectedUserID
        self.expectedAttemptID = expectedAttemptID
        deadline = expiresAtMilliseconds / 1_000
    }

    func claim(attemptID: String?, userID: String?, sameSession: Bool, now: TimeInterval) -> Claim {
        guard !settled else { return .ignored }
        guard sameSession, userID == expectedUserID, attemptID == expectedAttemptID, now < deadline else {
            return .stale
        }
        return .accepted
    }

    @discardableResult func settle() -> Bool {
        guard !settled else { return false }
        settled = true
        return true
    }

    @discardableResult func drainProvider() -> Bool {
        guard providerOutstanding else { return false }
        providerOutstanding = false
        return true
    }
}

/**
 * HushhAuthPlugin - Native iOS Authentication (Capacitor 8)
 *
 * Supports both Google Sign-In and Sign in with Apple.
 * Uses CAPBridgedPlugin protocol with pluginMethods array.
 * No .m bridging file needed.
 */
@objc(HushhAuthPlugin)
public class HushhAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    private enum TokenRefreshRejection: String {
        case userNotFound = "auth/user-not-found"
        case userDisabled = "auth/user-disabled"
        case invalidUserToken = "auth/invalid-user-token"
        case userTokenExpired = "auth/user-token-expired"
        case networkRequestFailed = "auth/network-request-failed"
        case internalError = "auth/internal-error"

        var message: String {
            switch self {
            case .userNotFound:
                return "The account no longer exists."
            case .userDisabled:
                return "The account has been disabled."
            case .invalidUserToken, .userTokenExpired:
                return "The current Firebase session is no longer valid."
            case .networkRequestFailed:
                return "Firebase could not be reached to validate the session."
            case .internalError:
                return "Firebase could not validate the current session."
            }
        }
    }
    
    // MARK: - CAPBridgedPlugin Protocol
    public let identifier = "HushhAuthPlugin"
    public let jsName = "HushhAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reauthenticateGoogleIdentity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectGmail", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectCalendar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectDrive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInWithApple", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getIdToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentUser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSignedIn", returnType: CAPPluginReturnPromise)
    ]
    
    // MARK: - Properties
    private let TAG = "HushhAuth"
    private var currentIdToken: String?
    private var currentAccessToken: String?
    private var googleInteractiveInFlight = false
    private final class IdentityReauthentication {
        let call: CAPPluginCall
        let user: FirebaseAuth.User
        let googleSubject: String
        let fence: GoogleIdentityReauthenticationFence

        init(call: CAPPluginCall, user: FirebaseAuth.User, googleSubject: String) {
            self.call = call
            self.user = user
            self.googleSubject = googleSubject
            fence = GoogleIdentityReauthenticationFence(
                expectedUserID: user.uid, now: ProcessInfo.processInfo.systemUptime
            )
        }
    }
    private var identityReauthentication: IdentityReauthentication?
    private final class DriveAuthorization: NSObject, ASWebAuthenticationPresentationContextProviding {
        let call: CAPPluginCall
        let user: FirebaseAuth.User
        let fence: NativeDriveAuthorizationFence
        weak var presenter: UIViewController?
        var session: ASWebAuthenticationSession?
        var timeout: DispatchWorkItem?

        init(call: CAPPluginCall, user: FirebaseAuth.User, attemptID: String,
             expiresAtMilliseconds: Double, presenter: UIViewController) {
            self.call = call
            self.user = user
            self.presenter = presenter
            fence = NativeDriveAuthorizationFence(
                expectedUserID: user.uid,
                expectedAttemptID: attemptID,
                expiresAtMilliseconds: expiresAtMilliseconds
            )
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            presenter?.view.window ?? UIWindow()
        }
    }
    private var driveAuthorization: DriveAuthorization?

    // Apple Sign-In properties
    private var currentNonce: String?
    private var appleSignInCall: CAPPluginCall?

    // MARK: - Keychain Helpers
    private static let keychainServiceName = "com.hushh.pda.auth"
    private let keychainService = HushhAuthPlugin.keychainServiceName

    /// Debug-test reset authority for a genuine first-launch authentication
    /// cadence. App uninstall does not clear iOS Keychain items, so Firebase
    /// sign-out alone can leave this plugin's cached identity/token restorable.
    /// Production code never calls this; user sign-out uses the instance path.
    static func clearPersistedSessionForNativeReset() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainServiceName
        ]
        SecItemDelete(query as CFDictionary)
        HusshIMessageSessionStore.shared.clearSilently()
        OneVoiceInvocationCoordinator.shared.cancelPending(outcome: "sign_out")
        OneSystemActionInvocationCoordinator.shared.cancelAll(
            outcome: "sign_out",
            clearEntityIndex: true
        )
    }

    private func keychainSet(_ value: String, forKey key: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data
        ]
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            print("⚠️ [\(TAG)] Keychain set failed for \(key): \(status)")
        }
    }

    private func keychainGet(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }

    private func keychainDelete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func keychainSetOptional(_ value: String?, forKey key: String) {
        keychainSet(value ?? "", forKey: key)
    }

    private func persistCachedUser(
        uid: String,
        email: String?,
        displayName: String?,
        photoUrl: String?,
        emailVerified: Bool,
        phoneNumber: String?
    ) {
        keychainSet(uid, forKey: "hushh_user_id")
        keychainSetOptional(email, forKey: "hushh_user_email")
        keychainSetOptional(displayName, forKey: "hushh_user_display_name")
        keychainSetOptional(photoUrl, forKey: "hushh_user_photo_url")
        keychainSet(emailVerified ? "true" : "false", forKey: "hushh_user_email_verified")
        keychainSetOptional(phoneNumber, forKey: "hushh_user_phone_number")
    }

    private func publishIMessageIdentitySilently(
        uid: String,
        email: String?,
        displayName: String?,
        photoUrl: String?,
        firebaseIDToken: String?
    ) {
        guard let firebaseIDToken, !firebaseIDToken.isEmpty else {
            return
        }

        let expiresAt = jwtExpiresAtMillis(firebaseIDToken)

        HusshIMessageSessionStore.shared.publishIdentitySilently(
            userID: uid,
            displayName: displayName,
            email: email,
            avatarURL: photoUrl,
            firebaseIDToken: firebaseIDToken,
            firebaseIDTokenExpiresAt: expiresAt
        )
    }

    private func cachedUserData() -> [String: Any]? {
        guard let uid = keychainGet("hushh_user_id"), !uid.isEmpty else {
            return nil
        }

        return [
            "uid": uid,
            "email": keychainGet("hushh_user_email") ?? "",
            "displayName": keychainGet("hushh_user_display_name") ?? "",
            "photoUrl": keychainGet("hushh_user_photo_url") ?? "",
            "emailVerified": (keychainGet("hushh_user_email_verified") ?? "false") == "true",
            "phoneNumber": keychainGet("hushh_user_phone_number") ?? ""
        ]
    }

    private func decodeJwtPayload(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count > 1 else { return nil }

        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - (base64.count % 4)) % 4
        if padding > 0 {
            base64 += String(repeating: "=", count: padding)
        }

        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json
    }

    private func jwtExpiresAtMillis(_ token: String) -> Int64? {
        guard let expValue = decodeJwtPayload(token)?["exp"] else {
            return nil
        }
        if let number = expValue as? NSNumber {
            return number.int64Value * 1_000
        }
        if let int = expValue as? Int {
            return Int64(int) * 1_000
        }
        if let double = expValue as? Double {
            return Int64(double * 1_000)
        }
        if let string = expValue as? String, let double = Double(string) {
            return Int64(double * 1_000)
        }
        return nil
    }

    private func isUsableCachedIdToken(_ token: String?) -> Bool {
        guard let token, !token.isEmpty,
              let expiresAtMs = jwtExpiresAtMillis(token) else {
            return false
        }

        let minRemainingMs = Date().timeIntervalSince1970 * 1000 + 60_000
        return Double(expiresAtMs) > minRemainingMs
    }

    private func freshCachedIdToken() -> String? {
        if isUsableCachedIdToken(currentIdToken) {
            return currentIdToken
        }
        let persisted = keychainGet("hushh_id_token")
        return isUsableCachedIdToken(persisted) ? persisted : nil
    }

    /// One-time migration: move tokens from UserDefaults to Keychain, then purge UserDefaults.
    private func migrateUserDefaultsToKeychain() {
        let keys = [
            "hushh_id_token",
            "hushh_access_token",
            "hushh_user_id",
            "hushh_user_email",
            "hushh_user_display_name",
            "hushh_user_photo_url",
            "hushh_user_email_verified"
        ]
        for key in keys {
            if let value = UserDefaults.standard.string(forKey: key), keychainGet(key) == nil {
                keychainSet(value, forKey: key)
                print("🔐 [\(TAG)] Migrated \(key) from UserDefaults → Keychain")
            }
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // Ensure Firebase is initialized before any FirebaseAuth call.
    private func ensureFirebaseConfigured() -> Bool {
        // Avoid FirebaseApp.app(): it logs an error for the expected
        // first-launch state before this plugin configures Firebase.
        if FirebaseApp.allApps?.isEmpty == false {
            return true
        }
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            print("❌ [\(TAG)] Missing GoogleService-Info.plist (required for FirebaseApp.configure)")
            return false
        }
        FirebaseApp.configure()
        print("✅ [\(TAG)] Firebase configured")
        migrateUserDefaultsToKeychain()
        return true
    }
    
    // MARK: - Sign In
    @objc func signIn(_ call: CAPPluginCall) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.signIn(call) }
            return
        }
        guard driveAuthorization == nil, identityReauthentication == nil,
              !googleInteractiveInFlight, appleSignInCall == nil else {
            call.reject("Identity verification is already in progress.", "identity_busy")
            return
        }
        print("🤖 [\(TAG)] signIn() CALLED - Native plugin invoked!")

        guard ensureFirebaseConfigured() else {
            call.reject("Missing GoogleService-Info.plist (Firebase not configured)")
            return
        }
        
        guard let viewController = bridge?.viewController else {
            call.reject("No view controller available")
            return
        }
        
        // Get Web Client ID from GoogleService-Info.plist
        guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let plist = NSDictionary(contentsOfFile: path),
              let clientId = plist["CLIENT_ID"] as? String else {
            call.reject("Missing GoogleService-Info.plist or CLIENT_ID")
            return
        }
        
        googleInteractiveInFlight = true
        let config = GIDConfiguration(clientID: clientId)
        GIDSignIn.sharedInstance.configuration = config
        
        GIDSignIn.sharedInstance.signIn(withPresenting: viewController) { [weak self] result, error in
            guard let self = self else { return }
            
            if let error = error {
                self.googleInteractiveInFlight = false
                print("❌ [\(self.TAG)] Google Sign-In failed")
                call.reject("Sign-in failed: \(error.localizedDescription)")
                return
            }
            
            guard let user = result?.user,
                  let idToken = user.idToken?.tokenString else {
                self.googleInteractiveInFlight = false
                call.reject("No ID token received from Google")
                return
            }
            
            let accessToken = user.accessToken.tokenString
            print("✅ [\(self.TAG)] Google account received")
            
            // Exchange for Firebase credential
            let credential = GoogleAuthProvider.credential(withIDToken: idToken, accessToken: accessToken)
            
            Auth.auth().signIn(with: credential) { authResult, error in
                if let error = error {
                    self.googleInteractiveInFlight = false
                    print("❌ [\(self.TAG)] Firebase sign-in failed")
                    call.reject("Firebase sign-in failed: \(error.localizedDescription)")
                    return
                }
                
                guard let firebaseUser = authResult?.user else {
                    self.googleInteractiveInFlight = false
                    call.reject("No Firebase user returned")
                    return
                }
                
                print("✅ [\(self.TAG)] Firebase sign-in succeeded")
                
                // Get Firebase ID token
                firebaseUser.getIDToken { firebaseIdToken, error in
                    defer { self.googleInteractiveInFlight = false }
                    if let error = error {
                        call.reject("Failed to get Firebase ID token: \(error.localizedDescription)")
                        return
                    }
                    
                    self.currentIdToken = firebaseIdToken
                    self.currentAccessToken = accessToken
                    
                    // Store in Keychain (BYOK-compliant secure storage)
                    if let token = firebaseIdToken {
                        self.keychainSet(token, forKey: "hushh_id_token")
                    }
                    self.keychainSet(accessToken, forKey: "hushh_access_token")
                    self.persistCachedUser(
                        uid: firebaseUser.uid,
                        email: firebaseUser.email,
                        displayName: firebaseUser.displayName,
                        photoUrl: firebaseUser.photoURL?.absoluteString,
                        emailVerified: firebaseUser.isEmailVerified,
                        phoneNumber: firebaseUser.phoneNumber
                    )
                    self.publishIMessageIdentitySilently(
                        uid: firebaseUser.uid,
                        email: firebaseUser.email,
                        displayName: firebaseUser.displayName,
                        photoUrl: firebaseUser.photoURL?.absoluteString,
                        firebaseIDToken: firebaseIdToken
                    )
                    
                    let response: [String: Any] = [
                        "idToken": firebaseIdToken ?? "",
                        "accessToken": accessToken,
                        "user": [
                "uid": firebaseUser.uid,
                            "email": firebaseUser.email ?? "",
                            "displayName": firebaseUser.displayName ?? "",
                            "photoUrl": firebaseUser.photoURL?.absoluteString ?? "",
                            "emailVerified": firebaseUser.isEmailVerified,
                            "phoneNumber": firebaseUser.phoneNumber ?? ""
                        ]
                    ]
                    
                    print("✅ [\(self.TAG)] call.resolve() completed with Firebase UID and Token")
                    call.resolve(response)
                }
            }
        }
    }

    /// Requests incremental Gmail consent without changing the Firebase session.
    /// The one-time server authorization code is returned to JavaScript only so
    /// it can be exchanged immediately by the authenticated backend.
    @objc func connectGmail(_ call: CAPPluginCall) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.connectGmail(call) }
            return
        }
        guard driveAuthorization == nil, identityReauthentication == nil,
              !googleInteractiveInFlight, appleSignInCall == nil else {
            call.reject("Identity verification is already in progress.", "identity_busy")
            return
        }
        guard ensureFirebaseConfigured() else {
            call.reject("Missing GoogleService-Info.plist (Firebase not configured)")
            return
        }

        guard let viewController = bridge?.viewController else {
            call.reject("No view controller available")
            return
        }

        guard let serverClientId = call.getString("serverClientId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !serverClientId.isEmpty else {
            call.reject("Missing Google server client ID")
            return
        }

        guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let plist = NSDictionary(contentsOfFile: path),
              let clientId = plist["CLIENT_ID"] as? String else {
            call.reject("Missing GoogleService-Info.plist or CLIENT_ID")
            return
        }

        googleInteractiveInFlight = true
        let configuration = GIDConfiguration(
            clientID: clientId,
            serverClientID: serverClientId
        )
        GIDSignIn.sharedInstance.configuration = configuration

        let purpose = call.getString("purpose")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "read"
        var gmailScopes = ["https://www.googleapis.com/auth/gmail.readonly"]
        if purpose == "send" {
            gmailScopes.append("https://www.googleapis.com/auth/gmail.send")
        }
        GIDSignIn.sharedInstance.signIn(
            withPresenting: viewController,
            hint: nil,
            additionalScopes: gmailScopes
        ) { result, error in
            defer { self.googleInteractiveInFlight = false }
            if let error = error {
                // kGIDSignInErrorCodeCanceled is -5. Avoid surfacing the SDK
                // error string so a normal cancellation remains a calm UI state.
                let isCanceled = (error as NSError).code == -5
                call.reject(
                    isCanceled ? "Mail connection was cancelled" : "Mail sign-in failed: \(error.localizedDescription)",
                    isCanceled ? "USER_CANCELLED" : nil
                )
                return
            }

            guard let serverAuthCode = result?.serverAuthCode,
                  !serverAuthCode.isEmpty else {
                call.reject("Google did not return a Mail authorization code")
                return
            }

            call.resolve(["serverAuthCode": serverAuthCode])
        }
    }

    /// Requests Calendar consent through the native Google SDK. The only value
    /// returned to JavaScript is the single-use code exchanged by the backend.
    @objc func connectCalendar(_ call: CAPPluginCall) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.connectCalendar(call) }
            return
        }
        guard driveAuthorization == nil, identityReauthentication == nil,
              !googleInteractiveInFlight, appleSignInCall == nil else {
            call.reject("Identity verification is already in progress.", "identity_busy")
            return
        }
        guard ensureFirebaseConfigured() else {
            call.reject("Missing GoogleService-Info.plist (Firebase not configured)")
            return
        }
        guard let viewController = bridge?.viewController else {
            call.reject("No view controller available")
            return
        }
        guard let serverClientId = call.getString("serverClientId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !serverClientId.isEmpty else {
            call.reject("Missing Google server client ID")
            return
        }
        let accessLevel = call.getString("accessLevel")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "read"
        guard accessLevel == "read" || accessLevel == "manage" else {
            call.reject("Unsupported Calendar access level")
            return
        }
        guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let plist = NSDictionary(contentsOfFile: path),
              let clientId = plist["CLIENT_ID"] as? String else {
            call.reject("Missing GoogleService-Info.plist or CLIENT_ID")
            return
        }

        googleInteractiveInFlight = true
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(
            clientID: clientId,
            serverClientID: serverClientId
        )
        let eventScope = accessLevel == "manage"
            ? "https://www.googleapis.com/auth/calendar.events"
            : "https://www.googleapis.com/auth/calendar.events.readonly"
        GIDSignIn.sharedInstance.signIn(
            withPresenting: viewController,
            hint: nil,
            additionalScopes: [eventScope, "https://www.googleapis.com/auth/calendar.freebusy"]
        ) { result, error in
            defer { self.googleInteractiveInFlight = false }
            if let error = error {
                let isCanceled = (error as NSError).code == -5
                call.reject(
                    isCanceled ? "Calendar connection was cancelled" : "Calendar sign-in failed: \(error.localizedDescription)",
                    isCanceled ? "USER_CANCELLED" : nil
                )
                return
            }
            guard let serverAuthCode = result?.serverAuthCode,
                  !serverAuthCode.isEmpty else {
                call.reject("Google did not return a Calendar authorization code")
                return
            }
            call.resolve(["serverAuthCode": serverAuthCode])
        }
    }
    
    // MARK: - Native Drive OAuth
    @objc func connectDrive(_ call: CAPPluginCall) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.connectDrive(call) }
            return
        }
        guard driveAuthorization == nil, identityReauthentication == nil,
              !googleInteractiveInFlight, appleSignInCall == nil else {
            call.reject("Another identity action is already in progress.", "identity_busy")
            return
        }
        guard let authorizeURL = call.getString("authorizeUrl").flatMap(URL.init(string:)),
              isTrustedDriveAuthorizeURL(authorizeURL),
              let attemptID = call.getString("attemptId"), isOpaqueDriveAttemptID(attemptID),
              let expectedUserID = call.getString("expectedUserId"), !expectedUserID.isEmpty,
              let expiresAt = call.getDouble("expiresAt"),
              expiresAt > Date().timeIntervalSince1970 * 1_000,
              expiresAt <= Date().timeIntervalSince1970 * 1_000 + 11 * 60 * 1_000,
              let user = Auth.auth().currentUser, user.uid == expectedUserID,
              let presenter = bridge?.viewController else {
            call.reject("Drive connection is unavailable.", "drive_connection_unavailable")
            return
        }

        let operation = DriveAuthorization(
            call: call, user: user, attemptID: attemptID,
            expiresAtMilliseconds: expiresAt, presenter: presenter
        )
        driveAuthorization = operation
        let timeout = DispatchWorkItem { [weak self, weak operation] in
            guard let self, let operation else { return }
            self.settleDriveAuthorization(operation, outcome: "failed", drainProvider: false)
        }
        operation.timeout = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + max(0, expiresAt / 1_000 - Date().timeIntervalSince1970),
            execute: timeout
        )

        let session = ASWebAuthenticationSession(
            url: authorizeURL,
            callbackURLScheme: "hushh"
        ) { [weak self, weak operation] callbackURL, error in
            DispatchQueue.main.async {
                guard let self, let operation else { return }
                guard operation.fence.drainProvider() else { return }
                if operation.fence.settled {
                    if operation.fence.canRelease, self.driveAuthorization === operation {
                        self.driveAuthorization = nil
                    }
                    return
                }
                guard error == nil else {
                    let outcome: String
                    if let authError = error as? ASWebAuthenticationSessionError,
                       authError.code == .canceledLogin {
                        outcome = "cancelled"
                    } else {
                        outcome = "failed"
                    }
                    self.settleDriveAuthorization(operation, outcome: outcome, drainProvider: false)
                    return
                }
                let result = callbackURL.flatMap(self.parseNativeDriveReturn)
                guard let result else {
                    self.settleDriveAuthorization(operation, outcome: "failed", drainProvider: false)
                    return
                }
                guard self.claimDriveAuthorization(operation, attemptID: result.attemptId) == .accepted else {
                    self.settleDriveAuthorization(operation, outcome: "failed", drainProvider: false)
                    return
                }
                self.settleDriveAuthorization(operation, outcome: result.outcome, drainProvider: false)
            }
        }
        operation.session = session
        session.presentationContextProvider = operation
        if !session.start() {
            settleDriveAuthorization(operation, outcome: "failed", drainProvider: true)
        }
    }

    private func isTrustedDriveAuthorizeURL(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "accounts.google.com" &&
            url.path == "/o/oauth2/v2/auth" && url.user == nil &&
            url.password == nil && url.port == nil && url.fragment == nil
    }

    private func isOpaqueDriveAttemptID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil
    }

    private func parseNativeDriveReturn(_ url: URL) -> (attemptId: String, outcome: String)? {
        guard url.scheme == "hushh", url.host == "connectors", url.path == "/return",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems, items.count == 2 else {
            return nil
        }
        let attempts = items.filter { $0.name == "attemptId" }.compactMap(\.value)
        let outcomes = items.filter { $0.name == "outcome" }.compactMap(\.value)
        guard attempts.count == 1, outcomes.count == 1, isOpaqueDriveAttemptID(attempts[0]),
              ["ready", "cancelled", "failed"].contains(outcomes[0]) else {
            return nil
        }
        return (attempts[0], outcomes[0])
    }

    private func claimDriveAuthorization(
        _ operation: DriveAuthorization, attemptID: String
    ) -> NativeDriveAuthorizationFence.Claim {
        guard driveAuthorization === operation else { return .ignored }
        let user = Auth.auth().currentUser
        return operation.fence.claim(
            attemptID: attemptID,
            userID: user?.uid,
            sameSession: user === operation.user,
            now: Date().timeIntervalSince1970
        )
    }

    private func settleDriveAuthorization(
        _ operation: DriveAuthorization, outcome: String, drainProvider: Bool
    ) {
        if drainProvider { _ = operation.fence.drainProvider() }
        guard operation.fence.settle() else { return }
        operation.timeout?.cancel()
        if outcome == "failed" { operation.session?.cancel() }
        if operation.fence.canRelease, driveAuthorization === operation {
            driveAuthorization = nil
        }
        operation.call.resolve([
            "attemptId": operation.fence.expectedAttemptID,
            "outcome": outcome
        ])
    }

    // MARK: - Fresh same-user Google proof
    @objc func reauthenticateGoogleIdentity(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.startIdentityReauthentication(call)
        }
    }

    private func startIdentityReauthentication(_ call: CAPPluginCall) {
        guard driveAuthorization == nil, identityReauthentication == nil,
              !googleInteractiveInFlight, appleSignInCall == nil else {
            call.reject("Identity verification is already in progress.", "identity_busy")
            return
        }
        guard ensureFirebaseConfigured(),
              let expectedUserID = call.getString("expectedUserId"), !expectedUserID.isEmpty,
              let user = Auth.auth().currentUser, user.uid == expectedUserID,
              let google = user.providerData.first(where: { $0.providerID == "google.com" }) else {
            call.reject("Verify the current Google identity.", "google_identity_required")
            return
        }
        guard let presenter = bridge?.viewController,
              let clientID = FirebaseApp.app()?.options.clientID, !clientID.isEmpty else {
            call.reject("Identity verification is unavailable.", "identity_verification_failed")
            return
        }
        let operation = IdentityReauthentication(call: call, user: user, googleSubject: google.uid)
        identityReauthentication = operation
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self, weak operation] in
            guard let self, let operation else { return }
            self.finishIdentity(operation, code: "identity_timeout")
        }
        GIDSignIn.sharedInstance.signIn(withPresenting: presenter, hint: user.email) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard operation.fence.drainProvider() else { return }
                if operation.fence.settled {
                    if self.identityReauthentication === operation { self.identityReauthentication = nil }
                    return
                }
                guard self.claimIdentity(operation, phase: 0) else { return }
                guard error == nil, let googleUser = result?.user,
                      let idToken = googleUser.idToken?.tokenString, !idToken.isEmpty else {
                    self.finishIdentity(operation, code: (error as NSError?)?.code == -5
                        ? "identity_cancelled" : "identity_verification_failed")
                    return
                }
                guard googleUser.userID == operation.googleSubject else {
                    self.finishIdentity(operation, code: "identity_mismatch")
                    return
                }
                let credential = GoogleAuthProvider.credential(
                    withIDToken: idToken, accessToken: googleUser.accessToken.tokenString
                )
                // Reauthenticate the captured user; never sign in a replacement.
                operation.user.reauthenticate(with: credential) { result, error in
                    DispatchQueue.main.async {
                        guard self.claimIdentity(operation, phase: 1) else { return }
                        guard error == nil, result?.user.uid == operation.fence.expectedUserID else {
                            self.finishIdentity(operation, code: "identity_verification_failed")
                            return
                        }
                        operation.user.getIDTokenForcingRefresh(true) { token, error in
                            DispatchQueue.main.async {
                                guard self.claimIdentity(operation, phase: 2) else { return }
                                guard error == nil, let token, !token.isEmpty else {
                                    self.finishIdentity(operation, code: "identity_verification_failed")
                                    return
                                }
                                guard operation.fence.settle() else { return }
                                self.identityReauthentication = nil
                                // Return only fresh Firebase proof. No Google credential,
                                // keychain write, cached fallback, or identity publication.
                                operation.call.resolve(["userId": operation.user.uid, "idToken": token])
                            }
                        }
                    }
                }
            }
        }
    }

    private func claimIdentity(_ operation: IdentityReauthentication, phase: Int) -> Bool {
        guard identityReauthentication === operation else { return false }
        let current = Auth.auth().currentUser
        switch operation.fence.claim(
            phase: phase, userID: current?.uid, sameSession: current === operation.user,
            now: ProcessInfo.processInfo.systemUptime
        ) {
        case .accepted: return true
        case .ignored: return false
        case .stale:
            finishIdentity(operation, code: "session_changed")
            return false
        }
    }

    private func finishIdentity(_ operation: IdentityReauthentication, code: String) {
        guard operation.fence.settle() else { return }
        // Keep an outstanding Google presentation reserved until its callback drains.
        if operation.fence.canRelease, identityReauthentication === operation {
            identityReauthentication = nil
        }
        operation.call.reject("Google identity verification did not complete.", code)
    }

    // MARK: - Sign Out
    @objc func signOut(_ call: CAPPluginCall) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.signOut(call) }
            return
        }
        if let operation = identityReauthentication { finishIdentity(operation, code: "session_changed") }
        if let operation = driveAuthorization {
            settleDriveAuthorization(operation, outcome: "failed", drainProvider: false)
        }
        print("🤖 [\(TAG)] signOut() called")
        
        // Sign out from Firebase
        do {
            try Auth.auth().signOut()
        } catch {
            print("⚠️ [\(TAG)] Firebase sign out failed")
        }
        
        // Sign out from Google
        GIDSignIn.sharedInstance.signOut()
        
        // Clear local state
        currentIdToken = nil
        currentAccessToken = nil
        keychainDelete("hushh_id_token")
        keychainDelete("hushh_access_token")
        keychainDelete("hushh_user_id")
        keychainDelete("hushh_user_email")
        keychainDelete("hushh_user_display_name")
        keychainDelete("hushh_user_photo_url")
        keychainDelete("hushh_user_email_verified")
        keychainDelete("hushh_user_phone_number")
        HusshIMessageSessionStore.shared.clearSilently()
        OneVoiceInvocationCoordinator.shared.cancelPending(outcome: "sign_out")
        OneSystemActionInvocationCoordinator.shared.cancelAll(
            outcome: "sign_out",
            clearEntityIndex: true
        )
        OneSystemRequestInvocationCoordinator.shared.cancelRequest()

        print("✅ [\(TAG)] Signed out")
        call.resolve()
    }

    // MARK: - Get ID Token
    private func tokenRefreshRejection(for error: Error) -> TokenRefreshRejection {
        switch (error as NSError).code {
        case AuthErrorCode.userNotFound.rawValue:
            return .userNotFound
        case AuthErrorCode.userDisabled.rawValue:
            return .userDisabled
        case AuthErrorCode.invalidUserToken.rawValue:
            return .invalidUserToken
        case AuthErrorCode.userTokenExpired.rawValue:
            return .userTokenExpired
        case AuthErrorCode.networkError.rawValue,
             AuthErrorCode.webNetworkRequestFailed.rawValue:
            return .networkRequestFailed
        default:
            return .internalError
        }
    }

    private func rejectForcedTokenRefresh(_ call: CAPPluginCall, error: Error?) {
        let rejection: TokenRefreshRejection
        if let error = error {
            rejection = tokenRefreshRejection(for: error)
            // Localized SDK details are diagnostic-only; JavaScript receives a
            // stable code and non-localized message so classification is safe.
            print("⚠️ [\(TAG)] Firebase token refresh failed [\(rejection.rawValue)]: \(error.localizedDescription)")
        } else {
            rejection = .invalidUserToken
            print("⚠️ [\(TAG)] Firebase token refresh returned no live token")
        }

        call.reject(rejection.message, rejection.rawValue)
    }

    @objc func getIdToken(_ call: CAPPluginCall) {
        let forceRefresh = call.getBool("forceRefresh") ?? false

        if let user = Auth.auth().currentUser {
            // Firebase owns forced-refresh authority. In that mode, a failed
            // refresh must not be hidden by the Keychain's unexpired token.
            user.getIDTokenResult(forcingRefresh: forceRefresh) { [weak self] result, error in
                guard let self = self else { return }

                if let token = result?.token, !token.isEmpty {
                    self.currentIdToken = token
                    self.keychainSet(token, forKey: "hushh_id_token")
                    self.publishIMessageIdentitySilently(
                        uid: user.uid,
                        email: user.email,
                        displayName: user.displayName,
                        photoUrl: user.photoURL?.absoluteString,
                        firebaseIDToken: token
                    )
                    call.resolve(["idToken": token])
                } else if forceRefresh {
                    self.rejectForcedTokenRefresh(call, error: error)
                } else if let cached = self.freshCachedIdToken() {
                    self.publishIMessageIdentitySilently(
                        uid: user.uid,
                        email: user.email,
                        displayName: user.displayName,
                        photoUrl: user.photoURL?.absoluteString,
                        firebaseIDToken: cached
                    )
                    call.resolve(["idToken": cached])
                } else {
                    call.resolve(["idToken": NSNull()])
                }
            }
        } else if forceRefresh {
            // A forced validation request with no live Firebase principal must
            // be terminal; returning null lets callers resurrect cached state.
            rejectForcedTokenRefresh(call, error: nil)
        } else if let cached = freshCachedIdToken() {
            call.resolve(["idToken": cached])
        } else {
            call.resolve(["idToken": NSNull()])
        }
    }
    
    // MARK: - Get Current User
    @objc func getCurrentUser(_ call: CAPPluginCall) {
        if let user = Auth.auth().currentUser {
            let userData: [String: Any] = [
                "uid": user.uid,
                "email": user.email ?? "",
                "displayName": user.displayName ?? "",
                "photoUrl": user.photoURL?.absoluteString ?? "",
                "emailVerified": user.isEmailVerified,
                "phoneNumber": user.phoneNumber ?? ""
            ]
            call.resolve(["user": userData])
        } else if freshCachedIdToken() != nil, let cached = cachedUserData() {
            call.resolve(["user": cached])
        } else {
            call.resolve(["user": NSNull()])
        }
    }
    
    // MARK: - Is Signed In
    @objc func isSignedIn(_ call: CAPPluginCall) {
        let signedIn =
            Auth.auth().currentUser != nil ||
            (freshCachedIdToken() != nil && cachedUserData() != nil)
        call.resolve(["signedIn": signedIn])
    }
    
    // MARK: - Apple Sign In
    @objc func signInWithApple(_ call: CAPPluginCall) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.signInWithApple(call) }
            return
        }
        guard driveAuthorization == nil, identityReauthentication == nil,
              !googleInteractiveInFlight, appleSignInCall == nil else {
            call.reject("Identity verification is already in progress.", "identity_busy")
            return
        }
        print("🍎 [\(TAG)] signInWithApple() CALLED - Native plugin invoked!")
        
        appleSignInCall = call
        
        // Generate nonce for security
        let nonce = randomNonceString()
        currentNonce = nonce
        
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = sha256(nonce)
        
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }
    
    // MARK: - Nonce Helpers
    private func randomNonceString(length: Int = 32) -> String {
        precondition(length > 0)
        var randomBytes = [UInt8](repeating: 0, count: length)
        let errorCode = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
        if errorCode != errSecSuccess {
            fatalError("Unable to generate nonce. SecRandomCopyBytes failed with OSStatus \(errorCode)")
        }
        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        let nonce = randomBytes.map { byte in
            charset[Int(byte) % charset.count]
        }
        return String(nonce)
    }
    
    private func sha256(_ input: String) -> String {
        let inputData = Data(input.utf8)
        let hashedData = SHA256.hash(data: inputData)
        let hashString = hashedData.compactMap {
            String(format: "%02x", $0)
        }.joined()
        return hashString
    }
}

// MARK: - ASAuthorizationControllerDelegate
extension HushhAuthPlugin: ASAuthorizationControllerDelegate {
    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let appleIDCredential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            appleSignInCall?.reject("Invalid Apple credential type")
            appleSignInCall = nil
            return
        }
        
        guard let appleIDToken = appleIDCredential.identityToken,
              let idTokenString = String(data: appleIDToken, encoding: .utf8) else {
            appleSignInCall?.reject("Unable to fetch identity token")
            appleSignInCall = nil
            return
        }
        
        guard let nonce = currentNonce else {
            appleSignInCall?.reject("Invalid state: A login callback was received, but no login request was sent.")
            appleSignInCall = nil
            return
        }
        
        print("✅ [\(TAG)] Apple credential received")
        
        // Exchange for Firebase credential using Apple-specific method
        let credential = OAuthProvider.appleCredential(
            withIDToken: idTokenString,
            rawNonce: nonce,
            fullName: appleIDCredential.fullName
        )
        
        Auth.auth().signIn(with: credential) { [weak self] authResult, error in
            guard let self = self else { return }
            
            if let error = error {
                print("❌ [\(self.TAG)] Firebase sign-in failed")
                self.appleSignInCall?.reject("Firebase sign-in failed: \(error.localizedDescription)")
                self.appleSignInCall = nil
                return
            }
            
            guard let firebaseUser = authResult?.user else {
                self.appleSignInCall?.reject("No Firebase user returned")
                self.appleSignInCall = nil
                return
            }
            
            print("✅ [\(self.TAG)] Firebase Apple sign-in succeeded")
            
            // Get Firebase ID token
            firebaseUser.getIDToken { firebaseIdToken, error in
                if let error = error {
                    self.appleSignInCall?.reject("Failed to get Firebase ID token: \(error.localizedDescription)")
                    self.appleSignInCall = nil
                    return
                }
                
                // Build display name from Apple credential (only available on first sign-in)
                var displayName = firebaseUser.displayName ?? ""
                if displayName.isEmpty, let fullName = appleIDCredential.fullName {
                    let givenName = fullName.givenName ?? ""
                    let familyName = fullName.familyName ?? ""
                    displayName = [givenName, familyName]
                        .filter { !$0.isEmpty }
                        .joined(separator: " ")
                }
                
                self.currentIdToken = firebaseIdToken
                
                // Store in Keychain (BYOK-compliant secure storage)
                if let token = firebaseIdToken {
                    self.keychainSet(token, forKey: "hushh_id_token")
                }
                self.persistCachedUser(
                    uid: firebaseUser.uid,
                    email: firebaseUser.email ?? appleIDCredential.email,
                    displayName: displayName,
                    photoUrl: firebaseUser.photoURL?.absoluteString,
                    emailVerified: firebaseUser.isEmailVerified,
                    phoneNumber: firebaseUser.phoneNumber
                )
                self.publishIMessageIdentitySilently(
                    uid: firebaseUser.uid,
                    email: firebaseUser.email ?? appleIDCredential.email,
                    displayName: displayName,
                    photoUrl: firebaseUser.photoURL?.absoluteString,
                    firebaseIDToken: firebaseIdToken
                )
                
                let response: [String: Any] = [
                    "idToken": firebaseIdToken ?? "",
                    "rawNonce": nonce,  // Needed for JS SDK sync if required
                    "user": [
                        "uid": firebaseUser.uid,
                        "email": firebaseUser.email ?? appleIDCredential.email ?? "",
                        "displayName": displayName,
                        "photoUrl": firebaseUser.photoURL?.absoluteString ?? "",
                        "emailVerified": firebaseUser.isEmailVerified,
                        "phoneNumber": firebaseUser.phoneNumber ?? ""
                    ]
                ]
                
                print("✅ [\(self.TAG)] Apple sign-in call.resolve() completed with Firebase UID and Token")
                self.appleSignInCall?.resolve(response)
                self.appleSignInCall = nil
            }
        }
    }
    
    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithError error: Error) {
        if let authError = error as? ASAuthorizationError {
            print("❌ [\(TAG)] Apple Sign-In failed: code=\(authError.code.rawValue)")
        } else {
            print("❌ [\(TAG)] Apple Sign-In failed")
        }
        
        // Check for user cancellation
        if let authError = error as? ASAuthorizationError {
            switch authError.code {
            case .canceled:
                appleSignInCall?.reject("User cancelled Apple Sign-In", "USER_CANCELLED")
            case .failed:
                appleSignInCall?.reject("Apple Sign-In failed: \(error.localizedDescription)")
            case .invalidResponse:
                appleSignInCall?.reject("Invalid response from Apple Sign-In")
            case .notHandled:
                appleSignInCall?.reject("Apple Sign-In request not handled")
            case .unknown:
                appleSignInCall?.reject("Unknown Apple Sign-In error: \(error.localizedDescription)")
            case .notInteractive:
                appleSignInCall?.reject("Apple Sign-In not interactive")
            case .matchedExcludedCredential:
                appleSignInCall?.reject("Matched excluded credential")
            case .credentialImport:
                appleSignInCall?.reject("Credential import error")
            case .credentialExport:
                appleSignInCall?.reject("Credential export error")
            case .preferSignInWithApple:
                appleSignInCall?.reject("Prefer Sign in with Apple")
            case .deviceNotConfiguredForPasskeyCreation:
                appleSignInCall?.reject("Device not configured for passkey creation")
            @unknown default:
                appleSignInCall?.reject("Apple Sign-In error: \(error.localizedDescription)")
            }
        } else {
            appleSignInCall?.reject("Apple Sign-In failed: \(error.localizedDescription)")
        }
        appleSignInCall = nil
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding
extension HushhAuthPlugin: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? UIWindow()
    }
}
