import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("native account lifecycle error contract", () => {
  it("preserves bounded iOS account-delete HTTP status, payload, and machine code", () => {
    const ios = source("ios/App/App/Plugins/HushhAccountPlugin.swift");

    expect(ios).toContain("maxErrorPayloadBytes = 16_384");
    expect(ios).toContain("maxErrorPayloadDepth = 6");
    expect(ios).toContain("maxErrorPayloadNodes = 64");
    expect(ios).toContain("maxErrorPayloadEntries = 32");
    expect(ios).toContain('["code", "error_code"]');
    expect(ios).toContain('"status": httpResponse.statusCode');
    expect(ios).toContain('rejectionData["payload"] = payload');
    expect(ios).toContain("call.reject(message, code, nil, rejectionData)");
  });

  it("preserves bounded Android account-delete HTTP status, payload, and machine code", () => {
    const android = source(
      "android/app/src/main/java/com/hussh/app/plugins/HushhAccount/HushhAccountPlugin.kt",
    );

    expect(android).toContain("maxErrorPayloadBytes = 16_384");
    expect(android).toContain("maxErrorPayloadDepth = 6");
    expect(android).toContain("maxErrorPayloadNodes = 64");
    expect(android).toContain("maxErrorPayloadEntries = 32");
    expect(android).toContain('listOf("code", "error_code")');
    expect(android).toContain('JSObject().put("status", response.code)');
    expect(android).toContain('rejectionData.put("payload", payload)');
    expect(android).toContain("call.reject(errorMessage, code, rejectionData)");
  });

  it("surfaces account-not-found as an exact typed Vault bridge rejection", () => {
    const ios = source("ios/App/App/Plugins/HushhVaultPlugin.swift");
    const android = source(
      "android/app/src/main/java/com/hussh/app/plugins/HushhVault/HushhVaultPlugin.kt",
    );

    expect(ios).toContain('accountNotFoundCode = "AUTH_ACCOUNT_NOT_FOUND"');
    expect(ios).toContain("if status == 401");
    expect(ios).toContain('call.reject("Account not found.", error)');
    expect(android).toContain(
      'accountNotFoundCode = "AUTH_ACCOUNT_NOT_FOUND"',
    );
    expect(android).toContain("status != 401");
    expect(android).toContain(
      'call.reject("Account not found.", lifecycleCode)',
    );
  });
});
