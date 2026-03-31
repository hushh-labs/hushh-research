# Apple App ID Capabilities for Hushh

**App Name**: Kai
**Bundle ID**: `com.hushh.app`  
**Date**: January 12, 2026

---

## ✅ Required Capabilities for App ID Registration

When registering your App ID at [developer.apple.com/account](https://developer.apple.com/account/resources/identifiers/list), you **MUST** enable the following capabilities based on Hushh's features:

### 🔐 1. **Associated Domains** (REQUIRED)
- **Why**: Firebase Authentication with Google Sign-In uses Universal Links
- **Used for**: 
  - Google OAuth redirect URLs
  - Firebase Dynamic Links
  - Deep linking support
- **Configuration**: Enable this capability
- **Domain setup**: Configure in Xcode later with your Firebase domains

### 📱 2. **Push Notifications** (REQUIRED)
- **Why**: Current native build config already enables remote notifications
- **Used for**:
  - Real-time consent request notifications
  - Agent Kai analysis completion alerts
  - Security alerts for vault access
- **Configuration**: Enable this capability
- **Current state**: `aps-environment` entitlement is present

### 🔑 3. **Sign In with Apple** (REQUIRED)
- **Why**: Apple Sign-In is already implemented and enabled in the current iOS entitlements
- **Used for**: Native sign-in flow alongside Google
- **Configuration**: Enable this capability
- **Current state**: `com.apple.developer.applesignin` entitlement is present

### 🌐 4. **App Groups** (OPTIONAL - Future)
- **Why**: Share data between app and potential app extensions
- **Used for**: 
  - Share Extension (future: share content to Hushh)
  - Widget support (future: vault status widget)
- **Configuration**: Enable if planning extensions
- **Identifier**: `group.com.hushh.app`

### 📂 5. **iCloud** (NOT REQUIRED - Currently Not Used)
- **Why**: Not currently used; local storage + backend sync instead
- **Note**: If you add CloudKit sync later, enable this

---

## 🚫 Capabilities NOT Needed

The following capabilities are **NOT required** for Hushh:

- ❌ **HomeKit**: Not a smart home app
- ❌ **HealthKit**: Not using health data
- ❌ **SiriKit**: No Siri integration
- ❌ **Apple Pay**: Not processing payments (free app)
- ❌ **Wallet**: Not using Wallet/Passes
- ❌ **Wireless Accessory Configuration**: Not configuring accessories
- ❌ **In-App Purchase**: No IAP (free app, server-side subscriptions if needed)
- ❌ **Game Center**: Not a game
- ❌ **Inter-App Audio**: Not an audio app
- ❌ **Personal VPN**: Not a VPN app
- ❌ **Network Extensions**: Not modifying network behavior
- ❌ **Multipath**: Not using multipath networking
- ❌ **Hot Spot**: Not configuring WiFi hotspots
- ❌ **NFC Tag Reading**: Not reading NFC tags
- ❌ **ClassKit**: Not an education app
- ❌ **AutoFill Credential Provider**: Not a password manager
- ❌ **Access WiFi Information**: Not needed
- ❌ **Communication Notifications**: Not using communication-specific notifications

---

## 📋 Step-by-Step: Register App ID with Capabilities

### Step 1: Navigate to App IDs
1. Go to [developer.apple.com/account](https://developer.apple.com/account)
2. Click **Certificates, Identifiers & Profiles**
3. Select **Identifiers** from the sidebar
4. Click the **+** button (top left)

### Step 2: Select App IDs
1. Select **App IDs**
2. Click **Continue**

### Step 3: Select Type
1. Select **App** (not App Clip)
2. Click **Continue**

### Step 4: Register App ID
Fill in the following:

#### Description
```
Hushh
```

#### Bundle ID
- Select **Explicit**
- Enter: `com.hushh.app`

#### Capabilities
Check these boxes:

##### ✅ REQUIRED:
- [x] **Associated Domains**

##### ✅ REQUIRED:
- [x] **Push Notifications**
- [x] **Sign In with Apple**

##### ⭕ OPTIONAL (Enable if planning to use):
- [ ] **App Groups** (if planning extensions/widgets)

##### ❌ Leave everything else unchecked

### Step 5: Register
1. Click **Continue**
2. Review your selections
3. Click **Register**
4. ✅ Done! Your App ID is ready

---

## 🔧 Xcode Configuration After Registration

After registering the App ID, configure capabilities in Xcode:

### 1. Open Xcode
```bash
cd <repo-root>/hushh-webapp
open ios/App/App.xcodeproj
```

### 2. Select App Target
1. Click **App** project in navigator
2. Select **App** target
3. Go to **Signing & Capabilities** tab

### 3. Add Associated Domains
1. Click **+ Capability**
2. Select **Associated Domains**
3. Add domains (after Firebase setup):
   ```
   applinks:your-app.firebaseapp.com
   applinks:your-app.page.link
   ```

### 4. Add Push Notifications (if enabled)
1. Click **+ Capability**
2. Select **Push Notifications**
3. No additional configuration needed

### 5. Add App Groups (if enabled)
1. Click **+ Capability**
2. Select **App Groups**
3. Add group ID: `group.com.hushh.app`

---

## 🔍 Current App Features & Permissions

### Authentication
- **Google Sign-In** (Native & Web)
  - Uses `@capacitor-firebase/authentication`
  - Requires Firebase configuration
  - Uses Universal Links (Associated Domains)
- **Sign in with Apple** (Native iOS)
  - Enabled in current entitlements
  - Shares the same bundle/App ID capability setup

### Data Storage
- **Local Encrypted Storage**
  - iOS: Keychain for sensitive data
  - Uses native `HushhVaultPlugin` for encryption
  - No iCloud sync (manual backend sync)

### File System Access
- **Document Storage**
  - Saves generated reports to Documents directory
  - Visible in Files app (UIFileSharingEnabled)
  - Uses `@capacitor/filesystem`

### Network
- **HTTPS API Calls**
  - Backend: `https://consent-protocol-1006304528804.us-central1.run.app`
  - All requests use TLS/SSL
  - No special network capabilities needed

### Native Plugins
Currently implemented:
1. **HushhAuthPlugin** - Native Google Sign-In
2. **HushhVaultPlugin** - Encryption/Decryption
3. **HushhConsentPlugin** - Consent management
4. **HushhIdentityPlugin** - Investor identity (Kai)
5. **HushhKeystorePlugin** - Secure key storage
6. **HushhSettingsPlugin** - App settings
7. **HushhSyncPlugin** - Data synchronization
8. **KaiPlugin** - Agent Kai stock analysis

---

## 📝 Info.plist Privacy Keys

Your app already has proper privacy configurations in `Info.plist`:

### Current Keys:
```xml
<!-- Google Sign-In Configuration -->
<key>GIDClientID</key>
<string>1006304528804-0kmnav8igjf7qbb3e4a2656d56ecvscm.apps.googleusercontent.com</string>

<key>CFBundleURLTypes</key>
<!-- URL scheme for Google OAuth -->

<!-- File Sharing -->
<key>UIFileSharingEnabled</key>
<true/>

<key>LSSupportsOpeningDocumentsInPlace</key>
<true/>

<!-- Network Security -->
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
</dict>
```

### ⚠️ Privacy Keys You May Need to Add:

If you later add features that use device capabilities, you'll need to add usage descriptions:

#### Camera (if adding photo upload):
```xml
<key>NSCameraUsageDescription</key>
<string>Hushh needs camera access to upload documents to your vault.</string>
```

#### Photo Library (if adding photo selection):
```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>Hushh needs photo access to select documents for your vault.</string>
```

#### Face ID / Touch ID (for biometric vault unlock):
```xml
<key>NSFaceIDUsageDescription</key>
<string>Hushh uses Face ID to securely unlock your vault.</string>
```

#### Location (if adding location-based features):
```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Hushh needs your location to enhance your experience.</string>
```

**Note**: Currently, none of these are needed. Only add them if you implement the features.

---

## 🔐 Firebase Setup Requirements

### Google Sign-In Configuration

#### 1. Firebase Console Setup
1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Select your project
3. Go to **Authentication** → **Sign-in method**
4. Enable **Google** provider
5. Add iOS app if not already added:
   - Bundle ID: `com.hushh.app`
   - Download `GoogleService-Info.plist`

#### 2. OAuth Client IDs
In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. **iOS OAuth Client**:
   - Application Type: iOS
   - Bundle ID: `com.hushh.app`
   - Copy Client ID to `Info.plist` → `GIDClientID`

2. **Web OAuth Client** (for Firebase):
   - Application Type: Web application
   - Authorized redirect URIs:
     ```
     https://your-project.firebaseapp.com/__/auth/handler
     ```

#### 3. Update Info.plist
Replace the `GIDClientID` and URL schemes in `Info.plist` with your new client ID:

```xml
<key>GIDClientID</key>
<string>YOUR-NEW-CLIENT-ID.apps.googleusercontent.com</string>

<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>com.googleusercontent.apps.YOUR-NEW-CLIENT-ID</string>
        </array>
    </dict>
</array>
```

#### 4. Associated Domains
In Xcode → Signing & Capabilities → Associated Domains, add:
```
applinks:your-project.firebaseapp.com
applinks:your-project.page.link
```

---

## 🚀 Production Checklist

Before submitting to App Store:

### Bundle ID & Signing
- [x] Bundle ID updated to `com.hushh.app` in all locations
- [ ] Xcode signing configured with your team
- [ ] Distribution certificate created
- [ ] App Store provisioning profile created

### Capabilities
- [ ] Associated Domains enabled in App ID
- [ ] Push Notifications enabled in App ID (if using)
- [ ] Associated domains configured in Xcode
- [ ] Push certificates created (if using notifications)

### Firebase
- [ ] iOS app added with bundle ID `com.hushh.app`
- [ ] `GoogleService-Info.plist` downloaded and replaced
- [ ] OAuth Client ID updated in Info.plist
- [ ] Associated domains added for Firebase

### Privacy & Security
- [ ] Privacy Policy URL ready
- [ ] Support URL ready
- [ ] App Review contact information ready
- [ ] Demo account for reviewers (if needed)
- [ ] NSAppTransportSecurity reviewed (remove if not needed for production)

### Assets
- [x] App icons generated (all sizes)
- [ ] App Store screenshots captured
- [ ] App Store icon (1024x1024) prepared
- [ ] Launch screen configured

### Testing
- [x] App builds successfully with new bundle ID
- [x] App runs on simulator
- [ ] App tested on real device
- [ ] Google Sign-In tested
- [ ] All native plugins tested
- [ ] File operations tested
- [ ] Vault encryption/decryption tested

---

## 📞 Support & Resources

### Apple Documentation
- **App ID Registration**: https://developer.apple.com/help/account/manage-identifiers/register-an-app-id
- **Capabilities**: https://developer.apple.com/documentation/xcode/capabilities
- **Associated Domains**: https://developer.apple.com/documentation/xcode/supporting-associated-domains

### Firebase Documentation
- **iOS Setup**: https://firebase.google.com/docs/ios/setup
- **Google Sign-In**: https://firebase.google.com/docs/auth/ios/google-signin
- **Associated Domains**: https://firebase.google.com/docs/auth/ios/google-signin#add_associated_domains

### Capacitor Documentation
- **iOS Configuration**: https://capacitorjs.com/docs/ios/configuration
- **Firebase Plugin**: https://github.com/capawesome-team/capacitor-firebase

---

## 🎯 Quick Reference: Minimal Setup

For the **absolute minimum** to get started with TestFlight:

### App ID Capabilities (Minimum):
1. ✅ **Associated Domains** (required for Google Sign-In)

### That's it! You can enable others later.

### Next Steps:
1. Register App ID with `com.hushh.app` + Associated Domains
2. Create Distribution Certificate
3. Create App Store Provisioning Profile
4. Configure signing in Xcode
5. Archive & Upload to App Store Connect
6. Start Internal Testing

---

**Last Updated**: January 12, 2026  
**Bundle ID**: com.hushh.app  
**Status**: ✅ App successfully running on simulator with new bundle ID
