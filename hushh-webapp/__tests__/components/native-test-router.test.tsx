import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs
    .readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

describe("NativeTestRouter", () => {
  it("covers expected route recovery guard", async () => {
    const { NativeTestRouter } = await import(
      "@/components/app-ui/native-test-router"
    );
    const source = read("components/app-ui/native-test-router.tsx");

    expect(NativeTestRouter).toEqual(expect.any(Function));
    expect(source).toContain(
      "const EXPECTED_ROUTE_RECOVERY_RETRY_MS = 5_000;",
    );
    expect(source).toContain(
      "let lastAppliedExpectedRouteRecovery: { key: string; appliedAt: number } | null = null;",
    );
    expect(source).toContain("const recoveryKey = [");
    expect(source).toContain("config.initialRoute");
    expect(source).toContain("config.expectedRoute");
    expect(source).toContain("currentRoute");
    expect(source).toContain('window.__HUSHH_NATIVE_TEST__?.bootstrapState || ""');
    expect(source).toContain("const recoveryRecentlyApplied =");
    expect(source).toContain("lastAppliedExpectedRouteRecovery?.key === recoveryKey");
    expect(source).toContain(
      "now - lastAppliedExpectedRouteRecovery.appliedAt <\n            EXPECTED_ROUTE_RECOVERY_RETRY_MS",
    );
    expect(source).toContain(
      "lastAppliedExpectedRouteRecovery = { key: recoveryKey, appliedAt: now };",
    );
    expect(source).toContain("!recoveryRecentlyApplied");
  });
});
