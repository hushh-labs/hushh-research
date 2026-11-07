import { execFileSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { syncNativeFirebaseConfigs } from "../../scripts/native/sync-native-firebase-configs.mjs";
import { validateNativeFirebaseIdentity } from "../../scripts/native/native-firebase-identity.mjs";

describe("native Firebase config sync CLI", () => {
  it("moves the iOS Google callback with the selected Firebase client and preserves other links", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-google-client-")));
    const appRoot = path.join(root, "app");
    const info = path.join(appRoot, "ios/App/App/Info.plist");
    try {
      vi.stubEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", "12345");
      mkdirSync(path.dirname(info), { recursive: true });
      writeFileSync(info, `<plist version="1.0"><dict><key>GIDClientID</key><string>old.apps.googleusercontent.com</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>com.googleusercontent.apps.old</string></array></dict><dict><key>CFBundleURLName</key><string>messages</string><key>CFBundleURLSchemes</key><array><string>hushh</string></array></dict></array><key>NSCameraUsageDescription</key><string>Keep this declaration.</string></dict></plist>`);
      const writeConfig = (client: string) => writeFileSync(path.join(root, "GoogleService-Info.plist"),
        `<plist version="1.0"><dict><key>BUNDLE_ID</key><string>com.hushh.app</string><key>PROJECT_ID</key><string>dev-fixture</string><key>GCM_SENDER_ID</key><string>12345</string><key>GOOGLE_APP_ID</key><string>1:12345:ios:fixture</string><key>CLIENT_ID</key><string>${client}.apps.googleusercontent.com</string><key>REVERSED_CLIENT_ID</key><string>com.googleusercontent.apps.${client}</string></dict></plist>`);
      const sync = () => syncNativeFirebaseConfigs({ appRoot, monorepoRoot: root, platform: "ios", expectedProjectId: "dev-fixture" });
      for (const client of ["dev-client", "production-client"]) {
        writeConfig(client);
        sync();
        const updated = readFileSync(info, "utf8");
        expect(updated).toContain(`<string>${client}.apps.googleusercontent.com</string>`);
        expect(updated).toContain(`<string>com.googleusercontent.apps.${client}</string>`);
        expect(updated).toContain("<string>hushh</string>");
        expect(updated).toContain("<string>Keep this declaration.</string>");
        const bytes = readFileSync(info);
        sync();
        expect(readFileSync(info)).toEqual(bytes);
      }
      const before = readFileSync(info);
      const sdk = path.join(appRoot, "ios/App/App/GoogleService-Info.plist");
      const priorSdk = readFileSync(sdk);
      writeConfig("mismatched-client");
      const source = path.join(root, "GoogleService-Info.plist");
      writeFileSync(source, readFileSync(source, "utf8").replace("com.googleusercontent.apps.mismatched-client", "com.googleusercontent.apps.foreign"));
      expect(sync).toThrow(/Google.*client|client.*Google/i);
      expect(readFileSync(info)).toEqual(before);
      expect(readFileSync(sdk)).toEqual(priorSdk);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["ios", "android"])("validates %s configs with the build overlay instead of the shell identity", (platform) => {
    const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "hushh-native-overlay-")));
    // Every recursive cleanup target is this newly created, absolute temp fixture.
    const appRoot = path.join(fixtureRoot, "hushh-webapp");
    try {
      for (const relative of [
        `scripts/native/with-${platform}-native-env.mjs`,
        "scripts/native/native-runtime-contract.mjs",
        "scripts/native/native-build-environment.mjs",
        "scripts/native/native-firebase-identity.mjs",
        "scripts/native/sync-native-firebase-configs.mjs",
        "scripts/native/sync-ios-google-signin.py",
        "scripts/testing/reviewer-test-identity.mjs",
      ]) {
        const destination = path.join(appRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(process.cwd(), relative), destination);
      }
      writeFileSync(path.join(appRoot, "capacitor.config.ts"), "export {};\n");
      if (platform === "ios") {
        const info = path.join(appRoot, "ios/App/App/Info.plist");
        mkdirSync(path.dirname(info), { recursive: true });
        copyFileSync(path.join(process.cwd(), "ios/App/App/Info.plist"), info);
      }
      writeFileSync(path.join(appRoot, `.env.native.${platform}.local`),
        "APP_RUNTIME_PROFILE=uat\nNEXT_PUBLIC_FIREBASE_PROJECT_ID=uat-fixture\nNEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=12345\n");
      const writeConfig = (project: string) => {
        if (platform === "ios") {
          writeFileSync(path.join(fixtureRoot, "GoogleService-Info.plist"),
            `<plist><dict><key>BUNDLE_ID</key><string>com.hushh.app</string><key>PROJECT_ID</key><string>${project}</string><key>GCM_SENDER_ID</key><string>12345</string><key>GOOGLE_APP_ID</key><string>1:12345:ios:native-fixture</string><key>CLIENT_ID</key><string>fixture.apps.googleusercontent.com</string><key>REVERSED_CLIENT_ID</key><string>com.googleusercontent.apps.fixture</string></dict></plist>`);
        } else {
          writeFileSync(path.join(fixtureRoot, "google-services.json"), JSON.stringify({
            project_info: { project_id: project, project_number: "12345" },
            client: [{ client_info: { android_client_info: { package_name: "com.hussh.app" }, mobilesdk_app_id: "1:12345:android:native-fixture" } }],
          }));
        }
      };
      const commands = [[
        path.join(appRoot, `scripts/native/with-${platform}-native-env.mjs`),
        process.execPath, "scripts/native/sync-native-firebase-configs.mjs", "--platform", platform,
      ]];
      if (platform === "android") {
        // Exercise the actual performance build's Firebase command under the
        // same conflicting shell/overlay fixture as Capacitor's command.
        const perfSource = readFileSync(path.join(process.cwd(), "scripts/perf/android-perf-card.sh"), "utf8");
        const command = perfSource.split(/\r?\n/).find(line => line.includes("scripts/native/sync-native-firebase-configs.mjs"));
        expect(command).toBeDefined();
        const argv = command!.split(">>")[0].trim().split(/\s+/);
        expect(argv[0]).toBe("node");
        commands.push(argv.slice(1));
      }
      const run = (args: string[]) => execFileSync(process.execPath, args, { cwd: appRoot, encoding: "utf8", stdio: "pipe", env: {
        // iOS uses the saved overlay only without an explicit profile; the
        // separate native-build suite protects explicit profile precedence.
        ...process.env, APP_RUNTIME_PROFILE: platform === "ios" ? "" : "prod", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "prod-fixture",
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "12345",
      } });
      writeConfig("prod-fixture");
      for (const args of commands) expect(() => run(args)).toThrow(/project mismatch/);
      writeConfig("uat-fixture");
      for (const args of commands) expect(run(args)).toContain(`Native Firebase configs ready (${platform};`);
      const scripts = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).scripts;
      expect(scripts[`cap:sync:${platform}`]).toContain(`with-${platform}-native-env.mjs node ./scripts/native/sync-native-firebase-configs.mjs --platform ${platform}`);
    } finally {
      expect(path.resolve(fixtureRoot).startsWith(realpathSync(tmpdir()) + path.sep)).toBe(true);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
  it("matches project and sender while allowing distinct web and native app IDs", () => {
    const expected = { expectedProject: "uat-fixture", expectedSender: "12345" };
    expect(() => validateNativeFirebaseIdentity({ projectId: "uat-fixture", senderId: "12345", nativeAppId: "1:12345:ios:native-app" }, expected)).not.toThrow();
    for (const patch of [{ projectId: "prod-fixture" }, { senderId: "98765" }, { nativeAppId: "1:98765:ios:wrong" }, { nativeAppId: undefined }]) {
      expect(() => validateNativeFirebaseIdentity({ projectId: "uat-fixture", senderId: "12345", nativeAppId: "1:12345:android:own", ...patch }, expected)).toThrow(/mismatch|selected sender/);
    }
  });
  it("runs as a direct Node entrypoint on the host platform", () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), "hushh-native-firebase-cli-"),
    );
    const appRoot = path.join(fixtureRoot, "hushh-webapp");
    const destination = path.join(
      appRoot,
      "android",
      "app",
      "google-services.json",
    );
    const scriptPath = path.join(
      process.cwd(),
      "scripts",
      "native",
      "sync-native-firebase-configs.mjs",
    );

    try {
      mkdirSync(appRoot, { recursive: true });
      writeFileSync(path.join(appRoot, "capacitor.config.ts"), "export {};\n");
      writeFileSync(
        path.join(fixtureRoot, "google-services.json"),
        JSON.stringify({
          project_info: { project_id: "fixture-project" },
          client: [
            {
              client_info: {
                android_client_info: { package_name: "com.hussh.app" },
              },
            },
          ],
        }),
      );

      const output = execFileSync(
        process.execPath,
        [scriptPath, "--platform", "android"],
        {
          cwd: appRoot,
          encoding: "utf8",
          stdio: "pipe",
        },
      );

      expect(output).toContain("Native Firebase configs ready (android;");
      expect(JSON.parse(readFileSync(destination, "utf8"))).toMatchObject({
        project_info: { project_id: "fixture-project" },
        client: [
          {
            client_info: {
              android_client_info: { package_name: "com.hussh.app" },
            },
          },
        ],
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts the app-scoped Android Firebase artifact used by Capacitor", () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), "hushh-native-firebase-app-scoped-"),
    );
    const appRoot = path.join(fixtureRoot, "hushh-webapp");
    const source = path.join(
      appRoot,
      "android",
      "app",
      "google-services.json",
    );
    const scriptPath = path.join(
      process.cwd(),
      "scripts",
      "native",
      "sync-native-firebase-configs.mjs",
    );

    try {
      mkdirSync(path.dirname(source), { recursive: true });
      writeFileSync(path.join(appRoot, "capacitor.config.ts"), "export {};\n");
      writeFileSync(
        source,
        JSON.stringify({
          project_info: { project_id: "app-scoped-fixture" },
          client: [
            {
              client_info: {
                android_client_info: { package_name: "com.hussh.app" },
              },
            },
          ],
        }),
      );

      execFileSync(process.execPath, [scriptPath, "--platform", "android"], {
        cwd: appRoot,
        encoding: "utf8",
        stdio: "pipe",
      });

      expect(JSON.parse(readFileSync(source, "utf8"))).toMatchObject({
        project_info: { project_id: "app-scoped-fixture" },
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("native Firebase selected project guard", () => {
  it.each(["ios", "android"])("refuses a foreign %s project before copying", (platform) => {
    const root = mkdtempSync(path.join(tmpdir(), "native-project-guard-"));
    const appRoot = path.join(root, "app");
    try {
      vi.stubEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", "12345");
      mkdirSync(appRoot);
      writeFileSync(path.join(root, "GoogleService-Info.plist"), "<plist><dict><key>BUNDLE_ID</key><string>com.hushh.app</string><key>PROJECT_ID</key><string>foreign-project</string><key>GCM_SENDER_ID</key><string>12345</string><key>GOOGLE_APP_ID</key><string>1:12345:ios:synthetic</string><key>CLIENT_ID</key><string>fixture.apps.googleusercontent.com</string><key>REVERSED_CLIENT_ID</key><string>com.googleusercontent.apps.fixture</string></dict></plist>");
      if (platform === "ios") {
        const info = path.join(appRoot, "ios/App/App/Info.plist");
        mkdirSync(path.dirname(info), { recursive: true });
        copyFileSync(path.join(process.cwd(), "ios/App/App/Info.plist"), info);
      }
      writeFileSync(path.join(root, "google-services.json"), JSON.stringify({ project_info: { project_id: "foreign-project", project_number: "12345" }, client: [{ client_info: { android_client_info: { package_name: "com.hussh.app" }, mobilesdk_app_id: "1:12345:android:synthetic" } }] }));
      expect(() => syncNativeFirebaseConfigs({ appRoot, monorepoRoot: root, platform, expectedProjectId: "selected-project" })).toThrow(/project mismatch/);
      expect(existsSync(path.join(appRoot, "ios/App/App/GoogleService-Info.plist"))).toBe(false);
      expect(existsSync(path.join(appRoot, "android"))).toBe(false);
      expect(() => syncNativeFirebaseConfigs({ appRoot, monorepoRoot: root, platform, expectedProjectId: "foreign-project" })).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
