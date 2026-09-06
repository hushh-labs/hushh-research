// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPrebuiltNativeEnvironment, nativeProfileMetadata, resolveNativeBuildEnvironment } from "../../scripts/native/native-build-environment.mjs";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "native-profile-fixture-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const dev = {
  APP_RUNTIME_PROFILE: "dev",
  NEXT_PUBLIC_APP_ENV: "uat",
  NEXT_PUBLIC_BACKEND_URL: "https://dev-backend.example",
  NEXT_PUBLIC_APP_URL: "https://dev-app.example",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "dev-fixture",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "dev-fixture.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_API_KEY: "synthetic-public-key",
  NEXT_PUBLIC_FIREBASE_APP_ID: "synthetic-web-app",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "123456",
};
function writeProfile(directory: string, name: string, values: Record<string, string>) {
  writeFileSync(join(directory, name), Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"));
}

describe("native build profile authority", () => {
  it("uses canonical profile aliases and dev's UAT runtime semantics", () => {
    expect(nativeProfileMetadata("dev-remote")).toEqual({ profile: "dev", source: ".env.dev.local", environment: "uat" });
    expect(() => nativeProfileMetadata("invalid-profile")).toThrow("Unsupported native build runtime profile");
  });

  it("selects dev without importing the saved UAT overlay or modifying files", () => {
    const appRoot = fixture();
    writeProfile(appRoot, ".env.dev.local", dev);
    writeProfile(appRoot, ".env.native.ios.local", { APP_RUNTIME_PROFILE: "uat", NEXT_PUBLIC_BACKEND_URL: "https://uat.example", NEXT_PUBLIC_UNRELATED_UAT_VALUE: "must-not-inherit" });
    const before = readFileSync(join(appRoot, ".env.dev.local"), "utf8");
    const resolved = resolveNativeBuildEnvironment({ appRoot, env: { APP_RUNTIME_PROFILE: "dev", NEXT_DIST_DIR: "/tmp/isolated-build", NODE_OPTIONS: "--max-old-space-size=4096" }, audit: true });
    expect(resolved.NEXT_PUBLIC_BACKEND_URL).toBe(dev.NEXT_PUBLIC_BACKEND_URL);
    expect(resolved.NEXT_PUBLIC_APP_ENV).toBe("uat");
    expect(resolved.NEXT_PUBLIC_UNRELATED_UAT_VALUE).toBeUndefined();
    expect(resolved.NEXT_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY).toBe("");
    expect(resolved.NEXT_DIST_DIR).toBe("/tmp/isolated-build");
    expect(resolved.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(readFileSync(join(appRoot, ".env.dev.local"), "utf8")).toBe(before);
    expect(resolveNativeBuildEnvironment({ appRoot, env: { APP_RUNTIME_PROFILE: "dev" } }).NEXT_PUBLIC_BACKEND_URL).toBe(dev.NEXT_PUBLIC_BACKEND_URL);
  });

  it("refuses missing dev identity instead of borrowing UAT", () => {
    const appRoot = fixture();
    writeProfile(appRoot, ".env.uat.local", { ...dev, APP_RUNTIME_PROFILE: "uat" });
    writeProfile(appRoot, ".env.native.ios.local", { ...dev, APP_RUNTIME_PROFILE: "uat" });
    writeProfile(appRoot, ".env.local", { ...dev, APP_RUNTIME_PROFILE: "uat" });
    expect(() => resolveNativeBuildEnvironment({ appRoot, env: { APP_RUNTIME_PROFILE: "dev" }, audit: true })).toThrow("incomplete");
    expect(() => resolveNativeBuildEnvironment({ appRoot, env: { APP_RUNTIME_PROFILE: "dev" } })).toThrow("incomplete");
  });

  it("preserves UAT audit defaults and the unselected release overlay", () => {
    const appRoot = fixture();
    writeProfile(appRoot, ".env.uat.local", { ...dev, APP_RUNTIME_PROFILE: "uat" });
    writeProfile(appRoot, ".env.native.ios.local", { NEXT_PUBLIC_BACKEND_URL: "https://saved-release.example" });
    expect(resolveNativeBuildEnvironment({ appRoot, env: {}, audit: true }).APP_RUNTIME_PROFILE).toBe("uat");
    expect(resolveNativeBuildEnvironment({ appRoot, env: {} }).NEXT_PUBLIC_BACKEND_URL).toBe("https://saved-release.example");
  });

  it("preserves explicit process values and refuses conflicting runtime semantics", () => {
    const appRoot = fixture();
    writeProfile(appRoot, ".env.dev.local", dev);
    expect(resolveNativeBuildEnvironment({ appRoot, env: { APP_RUNTIME_PROFILE: "dev", NEXT_PUBLIC_BACKEND_URL: "https://explicit-dev.example" }, audit: true }).NEXT_PUBLIC_BACKEND_URL).toBe("https://explicit-dev.example");
    expect(() => resolveNativeBuildEnvironment({ appRoot, env: { APP_RUNTIME_PROFILE: "dev", NEXT_PUBLIC_APP_ENV: "production" }, audit: true })).toThrow("conflicts");
  });

  it.each(["http://127.0.0.1:8000", "https://user:synthetic-secret@host.example", "https://host.example?token=synthetic-secret"])("refuses unsafe audit origins without disclosing them", (backend) => {
    const appRoot = fixture();
    writeProfile(appRoot, ".env.dev.local", dev);
    expect(() => resolveNativeBuildEnvironment({ appRoot, env: { APP_RUNTIME_PROFILE: "dev", NEXT_PUBLIC_BACKEND_URL: backend }, audit: true })).toThrow("remote HTTPS backend without embedded credentials");
  });
});

describe("prebuilt native target validation", () => {
  function bundle(backend = dev.NEXT_PUBLIC_BACKEND_URL, project = dev.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
    const appPath = fixture();
    writeFileSync(join(appPath, "capacitor.config.json"), JSON.stringify({ plugins: { One: { backendUrl: backend } } }));
    writeFileSync(join(appPath, "GoogleService-Info.plist"), `<plist><dict><key>PROJECT_ID</key><string>${project}</string></dict></plist>`);
    return appPath;
  }
  it("accepts the selected bundled backend and shared Firebase identity", () => {
    expect(() => verifyPrebuiltNativeEnvironment({ appPath: bundle(), env: dev })).not.toThrow();
  });
  it("rejects a foreign bundled backend despite the selected host environment", () => {
    expect(() => verifyPrebuiltNativeEnvironment({ appPath: bundle("https://foreign.example"), env: dev })).toThrow("rebuild");
  });
  it("rejects a foreign Firebase project", () => {
    expect(() => verifyPrebuiltNativeEnvironment({ appPath: bundle(undefined, "foreign"), env: dev })).toThrow("rebuild");
  });
  it("rejects missing artifacts without exposing their contents", () => {
    expect(() => verifyPrebuiltNativeEnvironment({ appPath: fixture(), env: dev })).toThrow("rebuild");
  });
  it("uses bundle validation in the route skip-build branch", () => {
    const source = readFileSync(join(process.cwd(), "scripts/native/ios-route-audit.mjs"), "utf8");
    expect(source).not.toContain("resolveNativeTestBackendUrl");
    expect(source).toContain("verifyPrebuiltNativeEnvironment({ appPath, env: process.env })");
  });
});
