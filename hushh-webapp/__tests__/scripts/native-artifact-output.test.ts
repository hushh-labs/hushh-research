// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { syncNativeUiTestRunner, writeNativeUiFlowsManifest } from "../../scripts/native/prepare-native-test-artifacts.mjs";
import { buildScopeCommerceSandboxArtifacts, exactSandboxFrontendOrigin, writeScopeCommerceSandboxArtifacts } from "../../scripts/native/prepare-scope-commerce-sandbox-links.mjs";
import { isNativeCustomConnectorReturnUri } from "../../lib/capacitor/oauth-return";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["", "isolated-export", "absolute"])("writes fresh artifacts to the selected Capacitor output: %s", (selection) => {
  const root = mkdtempSync(join(tmpdir(), "native-artifacts-"));
  roots.push(root);
  const output = selection === "absolute" ? join(root, "absolute-export") : join(root, selection || "out");
  vi.stubEnv("NEXT_DIST_DIR", selection === "absolute" ? output : selection);
  mkdirSync(join(root, "scripts/native"), { recursive: true });
  writeFileSync(join(root, "scripts/native/native-ui-test-runner-source.js"), "// synthetic runner\n");
  const manifest = writeNativeUiFlowsManifest({ repoRoot: root });
  syncNativeUiTestRunner({ repoRoot: root });
  expect(manifest.flowsPublicPath).toBe(join(output, "native-ui-flows.json"));
  expect(JSON.parse(readFileSync(manifest.flowsPublicPath, "utf8"))).toBeTruthy();
  expect(readFileSync(join(output, "native-ui-test-runner.js"), "utf8")).toBe("// synthetic runner\n");
  if (selection) expect(existsSync(join(root, "out"))).toBe(false);
});

const sandboxOrigin = "https://scope-commerce-preview-123.us-central1.run.app";
const fingerprint = Array(32).fill("AB").join(":");
const sandboxOptions = () => {
  const root = mkdtempSync(join(tmpdir(), "scope-commerce-native-"));
  roots.push(root);
  return { frontendOrigin: sandboxOrigin, androidFingerprints: [fingerprint], outputDir: join(root, "artifacts") };
};

it("pins public sandbox identities and exact account claims without changing production trust", () => {
  const options = sandboxOptions();
  const sourceFiles = ["ios/App/App/App.entitlements", "android/app/src/main/AndroidManifest.xml", "android/app/src/debug/AndroidManifest.xml"];
  const before = sourceFiles.map(file => readFileSync(join(process.cwd(), file), "utf8"));
  const result = writeScopeCommerceSandboxArtifacts(options);
  expect(result).toEqual({ filesWritten: 8, readinessVerified: false });
  const aasa = JSON.parse(readFileSync(join(options.outputDir, ".well-known/apple-app-site-association"), "utf8"));
  expect(aasa.applinks.details).toEqual([{ appIDs: ["WVDK9JW99C.com.hushh.app.scopecommerce.sandbox"], components: ["/one/profile/account", "/one/profile/connectors/oauth/return"].map(path => ({ "/": path, comment: expect.any(String) })) }]);
  expect(aasa).not.toHaveProperty("webcredentials");
  const assetlinks = JSON.parse(readFileSync(join(options.outputDir, ".well-known/assetlinks.json"), "utf8"));
  expect(assetlinks).toEqual([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.hussh.app.scopecommerce.sandbox", sha256_cert_fingerprints: [fingerprint] } }]);
  const manifest = readFileSync(join(options.outputDir, "android/AndroidManifest.xml"), "utf8");
  expect(manifest).toContain('android:host="scope-commerce-preview-123.us-central1.run.app" android:path="/one/profile/account"');
  expect(manifest).toContain('android:host="scope-commerce-preview-123.us-central1.run.app" android:path="/one/profile/connectors/oauth/return"');
  expect(manifest).toContain('tools:node="replace"');
  expect(manifest).toContain('android:path="/picker-return"');
  for (const prohibited of ["one.hushh.ai", 'android:pathPrefix="/one/profile/account"', "com.googleusercontent", "*"]) expect(manifest).not.toContain(prohibited);
  const entitlements = readFileSync(join(options.outputDir, "ios/ScopeCommerceSandbox.entitlements"), "utf8");
  expect(entitlements).toContain("applinks:scope-commerce-preview-123.us-central1.run.app");
  expect(entitlements).not.toContain("one.hushh.ai");
  expect(entitlements).not.toContain("keychain-access-groups");
  const plan = JSON.parse(readFileSync(join(options.outputDir, "build-plan.json"), "utf8"));
  expect(plan.environment.NEXT_PUBLIC_APP_URL).toBe(sandboxOrigin);
  expect(plan.environment.NEXT_PUBLIC_SCOPE_COMMERCE_SANDBOX_ORIGIN).toBe(sandboxOrigin);
  expect(plan.environment.NEXT_PUBLIC_IOS_BUNDLE_ID).toBe("com.hushh.app.scopecommerce.sandbox");
  expect(plan.commandsAfterReadiness.nativeSync).toEqual(["node", "./scripts/native/with-ios-native-env.mjs", "npx", "cap", "sync"]);
  expect(plan.commandsAfterReadiness.iosBuild).not.toContain("-xcconfig");
  expect(plan.commandsAfterReadiness.iosBuild.some((arg: string) => arg.startsWith("PRODUCT_BUNDLE_IDENTIFIER="))).toBe(false);
  expect(plan.iosDebugTargetSettings).toEqual({
    App: { PRODUCT_BUNDLE_IDENTIFIER: "com.hushh.app.scopecommerce.sandbox", DEVELOPMENT_TEAM: "WVDK9JW99C", CODE_SIGN_ENTITLEMENTS: join(options.outputDir, "ios/ScopeCommerceSandbox.entitlements") },
    AppTests: { PRODUCT_BUNDLE_IDENTIFIER: "com.hushh.app.scopecommerce.sandbox.tests" },
    AppUITests: { PRODUCT_BUNDLE_IDENTIFIER: "com.hushh.app.scopecommerce.sandbox.uitests" },
  });
  expect(plan.requiredReadiness).toContain("SANDBOX_FIREBASE_REGISTRATIONS");
  expect(plan.commandsAfterReadiness.androidBuild).toContain(":app:assembleDebug");
  expect(sourceFiles.map(file => readFileSync(join(process.cwd(), file), "utf8"))).toEqual(before);
  expect(() => writeScopeCommerceSandboxArtifacts(options)).toThrow("will not be overwritten");
});

it.each(["pinned", "missing", "mismatched", "normal_identity"])("requires the complete native sandbox callback pin: %s", state => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", sandboxOrigin);
  vi.stubEnv("NEXT_PUBLIC_SCOPE_COMMERCE_SANDBOX_ORIGIN", state === "missing" ? "" : state === "mismatched" ? "https://other.run.app" : sandboxOrigin);
  vi.stubEnv("NEXT_PUBLIC_IOS_BUNDLE_ID", "com.hushh.app.scopecommerce.sandbox");
  vi.stubEnv("NEXT_PUBLIC_ANDROID_APP_ID", state === "normal_identity" ? "com.hussh.app" : "com.hussh.app.scopecommerce.sandbox");
  const callback = "/one/profile/connectors/oauth/return";
  expect(isNativeCustomConnectorReturnUri(`${sandboxOrigin}${callback}`)).toBe(state === "pinned");
  for (const url of [`https://other.run.app${callback}`, `https://one.hushh.ai${callback}`, `${sandboxOrigin}/one/profile/account`, `${sandboxOrigin}${callback}?code=synthetic`]) {
    expect(isNativeCustomConnectorReturnUri(url)).toBe(false);
  }
});

it.each(["https://one.hushh.ai", "https://*.run.app", "http://scope.run.app", "https://scope.run.app.evil.invalid", "https://user:secret@scope.run.app", "https://scope.run.app:443", "https://scope.run.app/account", "https://scope.run.app?token=secret", "https://scope.run.app#token"])("rejects unpinned sandbox origin: %s", origin => {
  expect(() => exactSandboxFrontendOrigin(origin)).toThrow("exact default Cloud Run HTTPS frontend origin");
});

it("requires a real explicit certificate digest and refuses native-source write targets, including symlinks", () => {
  const options = sandboxOptions();
  expect(() => buildScopeCommerceSandboxArtifacts({ ...options, androidFingerprints: [] })).toThrow("Explicit SHA-256");
  expect(() => buildScopeCommerceSandboxArtifacts({ ...options, androidFingerprints: ["not-a-certificate"] })).toThrow("Explicit SHA-256");
  expect(() => writeScopeCommerceSandboxArtifacts({ ...options, outputDir: join(process.cwd(), "android/new-sandbox") })).toThrow("ignored tmp");
  const alias = join(options.outputDir, "..", "source-alias");
  symlinkSync(join(process.cwd(), "ios"), alias, "dir");
  expect(() => writeScopeCommerceSandboxArtifacts({ ...options, outputDir: join(alias, "new-sandbox") })).toThrow("ignored tmp");
});
