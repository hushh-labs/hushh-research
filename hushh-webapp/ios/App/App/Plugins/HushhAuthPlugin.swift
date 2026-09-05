import UIKit
import Capacitor
import FirebaseCore
import FirebaseAuth
import GoogleSignIn
import AuthenticationServices
import CryptoKit

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
        CAPPluginMethod(name: "connectGmail", returnType: CAPPluginReturnPromise),
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
        
        let config = GIDConfiguration(clientID: clientId)
        GIDSignIn.sharedInstance.configuration = config
        
        GIDSignIn.sharedInstance.signIn(withPresenting: viewController) { [weak self] result, error in
            guard let self = self else { return }
            
            if let error = error {
                print("❌ [\(self.TAG)] Google Sign-In failed")
                call.reject("Sign-in failed: \(error.localizedDescription)")
                return
            }
            
            guard let user = result?.user,
                  let idToken = user.idToken?.tokenString else {
                call.reject("No ID token received from Google")
                return
            }
            
            let accessToken = user.accessToken.tokenString
            print("✅ [\(self.TAG)] Google account received")
            
            // Exchange for Firebase credential
            let credential = GoogleAuthProvider.credential(withIDToken: idToken, accessToken: accessToken)
            
            Auth.auth().signIn(with: credential) { authResult, error in
                if let error = error {
                    print("❌ [\(self.TAG)] Firebase sign-in failed")
                    call.reject("Firebase sign-in failed: \(error.localizedDescription)")
                    return
                }
                
                guard let firebaseUser = authResult?.user else {
                    call.reject("No Firebase user returned")
                    return
                }
                
                print("✅ [\(self.TAG)] Firebase sign-in succeeded")
                
                // Get Firebase ID token
                firebaseUser.getIDToken { firebaseIdToken, error in
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

        let configuration = GIDConfiguration(
            clientID: clientId,
            serverClientID: serverClientId
        )
        GIDSignIn.sharedInstance.configuration = configuration

        let gmailScopes = [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send"
        ]
        GIDSignIn.sharedInstance.signIn(
            withPresenting: viewController,
            hint: nil,
            additionalScopes: gmailScopes
        ) { result, error in
            if let error = error {
                // kGIDSignInErrorCodeCanceled is -5. Avoid surfacing the SDK
                // error string so a normal cancellation remains a calm UI state.
                let isCanceled = (error as NSError).code == -5
                call.reject(
                    isCanceled ? "Gmail connection was cancelled" : "Gmail sign-in failed: \(error.localizedDescription)",
                    isCanceled ? "USER_CANCELLED" : nil
                )
                return
            }

            guard let serverAuthCode = result?.serverAuthCode,
                  !serverAuthCode.isEmpty else {
                call.reject("Google did not return a Gmail authorization code")
                return
            }

            call.resolve(["serverAuthCode": serverAuthCode])
        }
    }
    
    // MARK: - Sign Out
    @objc func signOut(_ call: CAPPluginCall) {
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
