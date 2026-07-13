# Mobile Build And Release

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## Fresh Native Build Rule

Always perform a fresh build when changing native Swift/Kotlin plugin code. Stale native build artifacts can hide source changes.

## iOS Local Build

```bash
cd hushh-webapp
rm -rf ~/Library/Developer/Xcode/DerivedData/App-*
npm run cap:build
npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App clean build \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -derivedDataPath ~/Library/Developer/Xcode/DerivedData/App-hushh
```

## Android Local Build

```bash
cd hushh-webapp
cd android && ./gradlew clean && cd ..
npm run cap:build
npx cap sync android
cd android && ./gradlew assembleDebug
```

## Static Export Constraint

For `CAPACITOR_BUILD=true`, App Router files are the canonical route surface. Do not depend on legacy alias redirects for mobile navigation.

Production static export checklist:

- set Capacitor dev server mode off
- run `npm run cap:build`
- run `npx cap sync`
- verify native `capacitor.config.json` has no localhost `server.url`

## Device Requirements

| Requirement | iOS     | Android     |
| ----------- | ------- | ----------- |
| Minimum OS  | iOS 16+ | Android 11+ |
| Target OS   | iOS 18+ | Android 14+ |

## App Store Release Checklist

Use this only for direct App Store submission for bundle ID `com.hushh.app`.

Operator prerequisites:

- active Apple Developer Program membership
- Account Holder, Admin, or App Manager access
- App Store Connect app record
- Apple Distribution certificate
- App Store provisioning profile
- Apple Team ID
- App Store Connect API key
- production runtime and Firebase config unless the build is intentionally UAT-branded

Local checks:

```bash
cd hushh-webapp
npm run typecheck
npm run ios:test
npm run ios:device:ui:test
```

Before archiving:

```bash
cd hushh-webapp
npm run ios:prepare:uat
```

After archiving:

```bash
cd hushh-webapp
npm run ios:verify-archive-symbols -- --repair "<path-to.xcarchive>"
```

Prepare App Store metadata, privacy answers, encryption/export compliance answers, review notes, support URL, privacy policy URL, demo credentials, screenshots, description, keywords, and age rating before submission.
