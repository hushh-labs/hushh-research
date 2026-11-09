import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const UAT_IOS_ANALYTICS_APP_ID = "1:745506018753:ios:efea0fede200b1d1778b40";
const SHARED_IOS_AUTH_APP_ID = "1:1006304528804:ios:eb2720b5eda7da4bcfd931";
export const SHARED_IOS_FIREBASE_RESOURCE = "FirebaseIdentity/GoogleService-Info.plist";
const analyticsPlist = (appRoot) => path.join(appRoot, ".env.local.d/ios/uat-analytics/GoogleService-Info.plist");

export function iosFirebaseField(plist, key) {
  const fields = [...plist.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "g"))];
  return fields.length === 1 ? fields[0][1] : "";
}

export function installedIosFirebaseField(plistPath, key) {
  const plist = fs.readFileSync(plistPath);
  return plist.subarray(0, 8).toString("ascii") === "bplist00"
    ? execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }).trim()
    : iosFirebaseField(plist.toString("utf8"), key);
}

export function verifyBundledIosUatFirebase(appPath) {
  const analytics = path.join(appPath, "GoogleService-Info.plist");
  const identity = path.join(appPath, SHARED_IOS_FIREBASE_RESOURCE);
  if (installedIosFirebaseField(analytics, "PROJECT_ID") !== "hushh-pda-uat" ||
      installedIosFirebaseField(analytics, "GOOGLE_APP_ID") !== UAT_IOS_ANALYTICS_APP_ID ||
      installedIosFirebaseField(identity, "PROJECT_ID") !== "hushh-pda" ||
      installedIosFirebaseField(identity, "GOOGLE_APP_ID") !== SHARED_IOS_AUTH_APP_ID ||
      installedIosFirebaseField(identity, "GCM_SENDER_ID") !== "1006304528804" ||
      !installedIosFirebaseField(identity, "CLIENT_ID")) {
    throw new Error("UAT iOS bundle does not contain the required Analytics and shared Firebase identities.");
  }
}

function verifyIosFirebasePlist(plist, { project, sender, appId, requiresOAuth = false }) {
  const field = (key) => iosFirebaseField(plist, key);
  if (field("PROJECT_ID") !== project || field("GCM_SENDER_ID") !== sender ||
      field("GOOGLE_APP_ID") !== appId || field("BUNDLE_ID") !== "com.hushh.app" ||
      !field("API_KEY") || (requiresOAuth && (!field("CLIENT_ID") || !field("REVERSED_CLIENT_ID")))) {
    throw new Error(`Refusing UAT iOS archive: invalid Firebase plist for ${project}.`);
  }
}

export function readUatIosAnalyticsPlist(appRoot) {
  const location = analyticsPlist(appRoot);
  if (!fs.existsSync(location)) {
    throw new Error("UAT iOS build requires .env.local.d/ios/uat-analytics/GoogleService-Info.plist.");
  }
  const plist = fs.readFileSync(location, "utf8");
  verifyIosFirebasePlist(plist, { project: "hushh-pda-uat", sender: "745506018753", appId: UAT_IOS_ANALYTICS_APP_ID });
  return location;
}

export function verifySharedIosFirebasePlist(location) {
  verifyIosFirebasePlist(fs.readFileSync(location, "utf8"), {
    project: "hushh-pda", sender: "1006304528804", appId: SHARED_IOS_AUTH_APP_ID, requiresOAuth: true,
  });
}

export async function ensureUatIosAnalyticsPlist(appRoot) {
  const location = analyticsPlist(appRoot);
  if (!fs.existsSync(location) && process.env.GITHUB_ACTIONS === "true" && process.env.GOOGLE_GHA_CREDS_PATH) {
    let plist;
    try {
      // Reuse this job's existing WIF identity. This fixed Firebase GET reads
      // public client configuration only and starts no Analytics or BigQuery job.
      const token = execFileSync("gcloud", ["auth", "print-access-token"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
      }).trim();
      if (!token) throw new Error("empty token");
      const app = encodeURIComponent(UAT_IOS_ANALYTICS_APP_ID);
      const response = await fetch(`https://firebase.googleapis.com/v1beta1/projects/hushh-pda-uat/iosApps/${app}/config`, {
        headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Firebase config read refused");
      const { configFileContents } = await response.json();
      if (typeof configFileContents !== "string" || configFileContents.length > 32_768) {
        throw new Error("unexpected config response");
      }
      plist = Buffer.from(configFileContents, "base64").toString("utf8");
    } catch {
      throw new Error("UAT iOS release identity could not read the dedicated Firebase Analytics client config.");
    }
    verifyIosFirebasePlist(plist, { project: "hushh-pda-uat", sender: "745506018753", appId: UAT_IOS_ANALYTICS_APP_ID });
    fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
    fs.writeFileSync(location, plist, { mode: 0o600, flag: "wx" });
  }
  return readUatIosAnalyticsPlist(appRoot);
}
