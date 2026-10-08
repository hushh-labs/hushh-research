/** Sandbox-only OS claim templates. Runtime trust remains the existing JS resolver. */
import { SANDBOX_IOS_APP_ID, SANDBOX_ANDROID_APP_ID } from "../../lib/capacitor/scope-commerce-sandbox-links.mjs";
export { SANDBOX_IOS_APP_ID, SANDBOX_ANDROID_APP_ID } from "../../lib/capacitor/scope-commerce-sandbox-links.mjs";
export const COMMERCE_ACCOUNT_PATH = "/one/profile/account";
export const CONNECTOR_CALLBACK_PATH = "/one/profile/connectors/oauth/return";
const SANDBOX_LINK_PATHS = [COMMERCE_ACCOUNT_PATH, CONNECTOR_CALLBACK_PATH];

export function sandboxAssociationDocuments({ host, teamId, fingerprints }) {
  return {
    aasa: { applinks: { apps: [], details: [{ appIDs: [`${teamId}.${SANDBOX_IOS_APP_ID}`],
      components: SANDBOX_LINK_PATHS.map(path => ({ "/": path, comment: "Sandbox arrival; session validation remains in the app." })),
    }] } },
    assetlinks: [{ relation: ["delegate_permission/common.handle_all_urls"], target: {
      namespace: "android_app", package_name: SANDBOX_ANDROID_APP_ID, sha256_cert_fingerprints: fingerprints,
    } }],
    entitlements: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.developer.associated-domains</key><array><string>applinks:${host}</string></array></dict></plist>\n`,
  };
}

export function sandboxAndroidManifest(mainManifest, host) {
  const source = mainManifest.replace(/<!--[\s\S]*?-->/g, "");
  const activities = [...source.matchAll(/<activity\b([^>]*android:name="\.MainActivity"[^>]*)>([\s\S]*?)<\/activity>/g)];
  if (activities.length !== 1) throw new Error("The canonical Android activity cannot be identified.");
  const [, attributes, body] = activities[0];
  // Retain launcher and app-owned opaque connector schemes from their owner.
  // Never inherit production HTTPS claims or Google's production OAuth client.
  const filters = [...body.matchAll(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g)]
    .map(match => match[0]).filter(filter => /android.intent.action.MAIN/.test(filter) ||
      (/android:scheme="hushh"/.test(filter) && !/android:scheme="(?:https?|com\.googleusercontent)/.test(filter)));
  if (!filters.some(filter => filter.includes("android.intent.action.MAIN"))) throw new Error("The canonical Android launcher is missing.");
  const activity = attributes.replace('android:name=".MainActivity"', 'android:name="com.hussh.app.MainActivity"');
  return `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"><application>
<meta-data android:name="asset_statements" tools:node="remove" />
<activity ${activity} tools:node="replace">${filters.join("\n")}
${SANDBOX_LINK_PATHS.map(path => `<intent-filter android:autoVerify="true"><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="https" android:host="${host}" android:path="${path}"/></intent-filter>`).join("\n")}
</activity></application></manifest>\n`;
}

export function sandboxGradleInit(manifestPath) {
  // JSON string quoting is also valid Groovy string quoting for these paths;
  // escape interpolation separately so a caller's path stays literal.
  const literal = JSON.stringify(manifestPath).replace(/\$/g, "\\$");
  return `// Use only with the sandbox debug variant; source/release settings stay unchanged.
def allowed = [':app:assembleDebug', ':app:testDebugUnitTest', ':app:processDebugMainManifest']
if (gradle.startParameter.taskNames.isEmpty() || !gradle.startParameter.taskNames.every { allowed.contains(it) }) {
    throw new GradleException('Sandbox tooling requires an explicit allowed debug task.')
}
gradle.beforeProject { p ->
    p.pluginManager.withPlugin('com.android.application') {
        p.extensions.getByName('androidComponents').finalizeDsl { android ->
            if (android.defaultConfig.applicationId != 'com.hussh.app') {
                throw new GradleException('Unexpected canonical Android application identity.')
            }
            android.buildTypes.getByName('debug').applicationIdSuffix = '.scopecommerce.sandbox'
            android.sourceSets.getByName('debug').manifest.srcFile(${literal})
        }
    }
}
`;
}

export function sandboxReadinessGuide({ frontendOrigin, teamId }) {
  return `# Scope commerce native sandbox artifacts

Pinned frontend: ${frontendOrigin}
Apple application: ${teamId}.${SANDBOX_IOS_APP_ID}
Android application: ${SANDBOX_ANDROID_APP_ID}

These files are preparation, not native acceptance. Serve the two .well-known
documents at the pinned HTTPS origin with JSON content type and no redirect.
The exact Account and connector callback claims cannot authorize payment or
sharing; the existing authenticated handlers validate their separate returns.

Before building in a disposable sandbox checkout:
1. Register BOTH exact sandbox identities in the selected Firebase project and
   verify their public native registration files. Do not use the normal
   sync-native-firebase-configs command: its contract is the production IDs.
2. Provide the sandbox iOS provisioning profile with Associated Domains and
   any capabilities needed by the normal sign-in path. Install the matching
   Firebase plist and registered OAuth URL scheme only in that sandbox checkout.
   Never copy production shared-keychain entitlements into the sandbox.
3. Provide Android google-services.json containing the exact sandbox package,
   register this build's signing certificate/OAuth client, and check the built
   APK certificate against the explicit assetlinks fingerprints. The generated
   debug overlay omits the production Google OAuth scheme and passkey relation.
4. Resolve the existing native runtime profile explicitly. Set the plan's public
   build environment in memory so APP_FRONTEND_ORIGIN is the pinned origin;
   inspect the bundled origin/backend and native application IDs after build.
   After webBuild run nativeSync through with-ios-native-env.mjs with the same
   in-memory build environment and explicitly resolved APP_RUNTIME_PROFILE.
   Do not use cap:sync:ios, which synchronizes production Firebase identities.
   Check plugins.HushhOAuthReturn.sandboxFrontendOrigin in the copied config.
5. In the disposable checkout, apply build-plan.json iosDebugTargetSettings
   to each named target's Debug build settings. Leave Release and dependency
   settings unchanged. The xcconfig is a reference for the App target only;
   never pass it through xcodebuild -xcconfig or globally override bundle IDs
   or entitlements. Global overrides also rename embedded frameworks and make
   device installation fail. Verify every embedded bundle retains its own ID.
6. Verify installed OS link association, then run existing normal-session iOS
   and Android reviewer tooling. Physical transport, unlock, automation-body
   entry, matching account, and normal vault admission are separate prerequisites.

No production host list, native source, env file, credential or device state was
changed by generation. Missing registration/provisioning/device evidence remains
an explicit blocker; a simulator build is not physical-device acceptance.
`;
}
