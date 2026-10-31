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
        swift.indexOf("// MARK: - Fresh same-user Google proof"),
      ),
    ],
    [
      "Android",
      kotlin.slice(
        kotlin.indexOf("// ==================== Native Drive OAuth"),
        kotlin.indexOf("// ==================== Fresh same-user Google proof"),
      ),
    ],
  ])(
    "%s accepts only a bound server-authored Drive attempt and returns no credentials",
    (_, source) => {
      expect(source).toContain("authorizeUrl");
      expect(source).toContain("attemptId");
      expect(source).toContain("expectedUserId");
      expect(source).toContain("expiresAt");
      expect(source).toContain("accounts.google.com");
      expect(source).toContain("/o/oauth2/v2/auth");
      expect(source).toContain("cancelled");
      expect(source).toContain("outcome");
      expect(source).not.toContain("serverAuthCode");
      expect(source).not.toContain("drive.file");
      expect(source).not.toMatch(
        /signInWithCredential|currentIdToken\s*=|currentUser\s*=|print\(|Log\./,
      );
    },
  );
});
