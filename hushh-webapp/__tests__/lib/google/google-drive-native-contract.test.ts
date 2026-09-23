import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const swift = readFileSync("ios/App/App/Plugins/HushhAuthPlugin.swift", "utf8");
const kotlin = readFileSync(
  "android/app/src/main/java/com/hussh/app/plugins/HushhAuth/HushhAuthPlugin.kt",
  "utf8",
);
const contract = readFileSync("lib/capacitor/index.ts", "utf8");
const web = readFileSync("lib/capacitor/plugins/auth-web.ts", "utf8");

describe("Drive native source contract (not device acceptance)", () => {
  it("registers the same narrow method on every bridge", () => {
    expect(contract).toContain("connectDrive(options:");
    expect(web).toContain("async connectDrive(_options:");
    expect(swift).toContain('CAPPluginMethod(name: "connectDrive"');
    expect(kotlin).toContain("fun connectDrive(call: PluginCall)");
  });
  it.each([
    [
      "iOS",
      swift.slice(
        swift.indexOf("@objc func connectDrive"),
        swift.indexOf("// MARK: - Sign Out"),
      ),
    ],
    [
      "Android",
      kotlin.slice(
        kotlin.indexOf("// ==================== Drive Connect"),
        kotlin.indexOf("// ==================== Sign Out"),
      ),
    ],
  ])(
    "%s requests only read-only Drive permission and returns no app identity",
    (_, source) => {
      expect(source).toContain(
        "https://www.googleapis.com/auth/drive.readonly",
      );
      expect(
        source.match(/https:\/\/www.googleapis.com\/auth\/[^"\s]+/g),
      ).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
      expect(source).toContain("serverAuthCode");
      expect(source).toContain("USER_CANCELLED");
      expect(source).not.toMatch(
        /signInWithCredential|Auth\.auth\(|firebaseAuth\.|currentIdToken\s*=|currentUser\s*=|print\(|Log\./,
      );
    },
  );
});
