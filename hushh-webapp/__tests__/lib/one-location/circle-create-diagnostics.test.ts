import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_APP_ENV = process.env.NEXT_PUBLIC_APP_ENV;

async function loadDiagnostics(appEnv: string) {
  process.env.NEXT_PUBLIC_APP_ENV = appEnv;
  vi.resetModules();
  return import("@/lib/one-location/circle-create-diagnostics");
}

describe("circle create diagnostics", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.NEXT_PUBLIC_APP_ENV = ORIGINAL_APP_ENV;
    vi.resetModules();
  });

  it("writes the trace on development and UAT", async () => {
    for (const env of ["development", "uat"]) {
      const mod = await loadDiagnostics(env);
      expect(mod.isCircleCreateDiagnosticsEnabled(), env).toBe(true);
      mod.logCircleCreate("Click", { attemptId: "cc_1", circleKind: "family" });
      expect(console.warn, env).toHaveBeenCalledWith("[CircleCreate:Click]", {
        attemptId: "cc_1",
        circleKind: "family",
      });
      vi.mocked(console.warn).mockClear();
    }
  });

  it("is silent in production", async () => {
    // Diagnostics are for reading a UAT console, not for shipping a running
    // commentary to every user's browser.
    const mod = await loadDiagnostics("production");
    expect(mod.isCircleCreateDiagnosticsEnabled()).toBe(false);
    mod.logCircleCreate("Click", { attemptId: "cc_1" });
    mod.logCircleCreateLockCheck("cc_1", "locked");
    mod.logCircleCreateLockGuard("cc_1", "unlock_required", "no_owner_token");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("is silent inside a packaged store app, which is also stamped uat", async () => {
    // The App Store and Play Store lanes set NEXT_PUBLIC_APP_ENV=uat because
    // they ship against the UAT backend, so an environment check alone reads
    // every store install as non-production. Distribution and backend
    // environment are separate facts.
    vi.doMock("@capacitor/core", () => ({
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
    }));
    vi.doMock("@/lib/testing/native-test", () => ({
      isNativeUiTestSession: () => false,
    }));
    const mod = await loadDiagnostics("uat");
    expect(mod.isCircleCreateDiagnosticsEnabled()).toBe(false);
    mod.logCircleCreate("Click", { attemptId: "cc_1" });
    expect(console.warn).not.toHaveBeenCalled();
    vi.doUnmock("@capacitor/core");
    vi.doUnmock("@/lib/testing/native-test");
  });

  it("traces a driven native session, which is an operator context", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
    }));
    vi.doMock("@/lib/testing/native-test", () => ({
      isNativeUiTestSession: () => true,
    }));
    const mod = await loadDiagnostics("uat");
    expect(mod.isCircleCreateDiagnosticsEnabled()).toBe(true);
    vi.doUnmock("@capacitor/core");
    vi.doUnmock("@/lib/testing/native-test");
  });

  it("redacts anything secret-shaped that reaches it", async () => {
    // The payloads below should never be written by the call sites. The point
    // of the backstop is that a future edit adding one cannot leak it.
    const mod = await loadDiagnostics("uat");
    mod.logCircleCreate("LockCheck", {
      attemptId: "cc_1",
      stray:
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop qrst@example.com",
    });
    const [, detail] = vi.mocked(console.warn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(String(detail.stray)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(String(detail.stray)).not.toContain("qrst@example.com");
    expect(String(detail.stray)).toContain("[REDACTED");
  });

  it("keeps a circle id short enough not to be an identifier", async () => {
    const mod = await loadDiagnostics("uat");
    expect(mod.circleIdPrefix("0f2a51c8-9b31-4f6e-a0d2-1c8e7b4a55d3")).toBe(
      "0f2a51c8",
    );
    expect(mod.circleIdPrefix(null)).toBe("");
    expect(mod.circleIdPrefix(undefined)).toBe("");
  });

  it("gives every attempt its own correlation id", async () => {
    const mod = await loadDiagnostics("uat");
    const a = mod.createCircleCreateAttemptId();
    const b = mod.createCircleCreateAttemptId();
    expect(a).not.toBe(b);
    expect(a.startsWith("cc_")).toBe(true);
  });

  it("prints the correlation id and the source instead of redacting them", async () => {
    // The redactor runs over every payload, and it is aggressive: a full UUID
    // matches its long-secret rule and a `vault_…` word matches its key rule.
    // A trace whose correlation id reads `[REDACTED_SECRET]` on every line
    // correlates nothing, which is the whole point of having one. This is
    // measured off the real output rather than assumed.
    const mod = await loadDiagnostics("uat");
    const attemptId = mod.createCircleCreateAttemptId();
    mod.logCircleCreateLockCheck(attemptId, "locked");
    const [, detail] = vi.mocked(console.warn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(detail.attemptId).toBe(attemptId);
    expect(String(detail.attemptId)).not.toContain("REDACTED");
    expect(String(detail.source)).not.toContain("REDACTED");
    expect(detail.lockState).toBe("locked");
  });

  it("drops undefined keys rather than printing them", async () => {
    const mod = await loadDiagnostics("uat");
    mod.logCircleCreate("Success", { attemptId: "cc_1", circleIdPrefix: undefined });
    expect(console.warn).toHaveBeenCalledWith("[CircleCreate:Success]", {
      attemptId: "cc_1",
    });
  });
});

describe("the trace survives the build it is meant to be read in", () => {
  it("emits only on levels next.config.ts keeps", async () => {
    // `removeConsole: isCapacitorBuild ? false : { exclude: ["error", "warn"] }`
    // strips every other console level from a web build at compile time. The
    // first version of this module used `console.info` -- correct by the repo's
    // own convention, and verified ABSENT from every chunk served by
    // uat.one.hushh.ai. A unit test cannot see that, so pin the two facts that
    // together make the trace readable: the level this module uses, and the
    // levels the build keeps.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../../..");

    const nextConfig = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
    const match = nextConfig.match(/removeConsole:[^\n]*exclude:\s*\[([^\]]*)\]/);
    expect(match, "next.config.ts no longer declares removeConsole.exclude").toBeTruthy();
    const kept = String(match?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/["']/g, ""))
      .filter(Boolean);
    expect(kept).toContain("warn");

    const source = fs.readFileSync(
      path.join(root, "lib/one-location/circle-create-diagnostics.ts"),
      "utf8",
    );
    const levels = Array.from(source.matchAll(/console\.(\w+)\(/g)).map((m) => m[1]);
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(kept, `console.${level} is stripped from a web build`).toContain(level);
    }
  });
});
