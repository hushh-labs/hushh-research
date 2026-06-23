import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SecurityEventType } from "@/lib/config";

vi.mock("@/lib/app-env", () => ({
  resolveAppEnvironment: vi.fn(),
}));

vi.mock("@/lib/runtime/settings", () => ({
  resolveRuntimeBackendUrl: vi.fn(),
  resolveRuntimeFrontendUrl: vi.fn(),
}));

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports development mode correctly", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");

    const config = await import("@/lib/config");

    expect(config.isDevelopment()).toBe(true);
    expect(config.isProduction()).toBe(false);
  });

  it("reports production mode correctly", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");

    vi.mocked(resolveAppEnvironment).mockReturnValue("production");

    const config = await import("@/lib/config");

    expect(config.isDevelopment()).toBe(false);
    expect(config.isProduction()).toBe(true);
  });

  it("uses development backend fallback when runtime backend url is empty", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("http://127.0.0.1:8000");
  });

  it("resolves configured development backend url", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue(
      " http://localhost:8000/ "
    );

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("http://localhost:8000");
  });

  it("uses development frontend fallback when runtime frontend url is empty", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeFrontendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");
    vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.APP_FRONTEND_ORIGIN).toBe("http://localhost:3000");
  });

  it("keeps production backend empty when runtime backend url is empty", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("production");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("");
  });

  it("resolves UAT backend url from runtime settings", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("uat");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue(
      "https://uat-api.hushh.ai/",
    );

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("https://uat-api.hushh.ai");
      });

      it("keeps production frontend origin empty when runtime frontend url is empty", async () => {
        const { resolveAppEnvironment } = await import("@/lib/app-env");
        const { resolveRuntimeFrontendUrl } = await import(
          "@/lib/runtime/settings"
        );

        vi.mocked(resolveAppEnvironment).mockReturnValue("production");
        vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue("");

        const config = await import("@/lib/config");

        expect(config.APP_FRONTEND_ORIGIN).toBe("");
      });

      it("resolves configured frontend origin", async () => {
        const { resolveAppEnvironment } = await import("@/lib/app-env");
        const { resolveRuntimeFrontendUrl } = await import(
          "@/lib/runtime/settings"
        );

        vi.mocked(resolveAppEnvironment).mockReturnValue("uat");
        vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue(
          " https://uat-app.hushh.ai/ "
        );

        const config = await import("@/lib/config");

        expect(config.APP_FRONTEND_ORIGIN).toBe(
          "https://uat-app.hushh.ai"
        );
      });
    });

    describe("config — ENVIRONMENT_MODE contract", () => {
      beforeEach(() => {
        vi.resetModules();
      });

      it("captures environment mode at import time", async () => {
        const { resolveAppEnvironment } = await import("@/lib/app-env");

        vi.mocked(resolveAppEnvironment).mockReturnValue("uat");

        const config = await import("@/lib/config");

        expect(config.ENVIRONMENT_MODE).toBe("uat");
      });
    });

    describe("config — logSecurityEvent contract", () => {
      beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, "log").mockImplementation(() => undefined);
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("logs security events with details payload", async () => {
        const { resolveAppEnvironment } = await import("@/lib/app-env");

        vi.mocked(resolveAppEnvironment).mockReturnValue("production");

        const config = await import("@/lib/config");

        const details = {
          userId: "user-1",
          customAuditField: "extra-context",
        };

        config.logSecurityEvent("TOKEN_VALID", details);

        expect(console.log).toHaveBeenCalledTimes(1);

        const [, loggedDetails] =
          vi.mocked(console.log).mock.calls[0]!;

        expect(loggedDetails).toEqual(details);
      });
    });

    describe("config — SecurityEventType exhaustiveness contract", () => {
      const ALL_SECURITY_EVENT_TYPES: SecurityEventType[] = [
        "TOKEN_VALID",
        "TOKEN_INVALID",
        "TOKEN_VALIDATION_FAILED",
        "TOKEN_VALIDATION_ERROR",
        "SCOPE_MISMATCH",
        "FIREBASE_TOKEN_VALID",
        "FIREBASE_TOKEN_INVALID",
        "FIREBASE_VALIDATION_ERROR",
        "VAULT_READ_REJECTED",
        "VAULT_READ_SUCCESS",
        "VAULT_WRITE_REJECTED",
        "VAULT_WRITE_SUCCESS",
        "VAULT_KEY_REJECTED",
        "VAULT_KEY_SUCCESS",
        "VAULT_CHECK_REJECTED",
        "VAULT_CHECK_SUCCESS",
        "VAULT_SETUP_SUCCESS",
        "PREFERENCES_READ_REJECTED",
        "PREFERENCES_READ_SUCCESS",
        "CONSENT_VERIFIED",
        "CONSENT_REQUIRED",
        "CONSENT_INVALID",
        "USER_MISMATCH",
        "CHAT_REJECTED",
        "RECOMMEND_REJECTED",
        "RECOMMEND_SUCCESS",
        "DEV_AUTO_GRANT",
        "DEV_FIREBASE_BYPASS",
      ];

      beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, "log").mockImplementation(() => undefined);
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("accepts all known security event types", async () => {
        const { resolveAppEnvironment } = await import("@/lib/app-env");

        vi.mocked(resolveAppEnvironment).mockReturnValue("production");

        const config = await import("@/lib/config");

        for (const event of ALL_SECURITY_EVENT_TYPES) {
          expect(() =>
            config.logSecurityEvent(event, {})
          ).not.toThrow();
        }
      });
    });
