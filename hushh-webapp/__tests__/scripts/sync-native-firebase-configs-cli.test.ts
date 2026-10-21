import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { validateNativeFirebaseIdentity } from "../../scripts/native/native-firebase-identity.mjs";

describe("native Firebase config sync CLI", () => {
  it.each(["ios", "android"])("validates %s configs with the build overlay instead of the shell identity", (platform) => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "hushh-native-overlay-"));
    // Every recursive cleanup target is this newly created, absolute temp fixture.
    const appRoot = path.join(fixtureRoot, "hushh-webapp");
    try {
      for (const relative of [
        `scripts/native/with-${platform}-native-env.mjs`,
        "scripts/native/native-runtime-contract.mjs",
        "scripts/native/native-firebase-identity.mjs",
        "scripts/native/sync-native-firebase-configs.mjs",
        "scripts/testing/reviewer-test-identity.mjs",
      ]) {
        const destination = path.join(appRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(process.cwd(), relative), destination);
      }
      writeFileSync(path.join(appRoot, "capacitor.config.ts"), "export {};\n");
      writeFileSync(path.join(appRoot, `.env.native.${platform}.local`),
        "APP_RUNTIME_PROFILE=uat\nNEXT_PUBLIC_FIREBASE_PROJECT_ID=uat-fixture\nNEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=12345\n");
      const writeConfig = (project: string) => {
        if (platform === "ios") {
          writeFileSync(path.join(fixtureRoot, "GoogleService-Info.plist"),
            `<plist><dict><key>BUNDLE_ID</key><string>com.hushh.app</string><key>PROJECT_ID</key><string>${project}</string><key>GCM_SENDER_ID</key><string>12345</string><key>GOOGLE_APP_ID</key><string>1:12345:ios:native-fixture</string></dict></plist>`);
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
        ...process.env, APP_RUNTIME_PROFILE: "prod", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "prod-fixture",
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "12345",
      } });
      writeConfig("prod-fixture");
      for (const args of commands) expect(() => run(args)).toThrow(/project mismatch/);
      writeConfig("uat-fixture");
      for (const args of commands) expect(run(args)).toContain(`Native Firebase configs ready (${platform};`);
      const scripts = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).scripts;
      expect(scripts[`cap:sync:${platform}`]).toContain(`with-${platform}-native-env.mjs node ./scripts/native/sync-native-firebase-configs.mjs --platform ${platform}`);
    } finally {
      expect(path.resolve(fixtureRoot).startsWith(path.resolve(tmpdir()) + path.sep)).toBe(true);
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
