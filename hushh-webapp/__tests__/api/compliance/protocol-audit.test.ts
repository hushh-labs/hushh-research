// __tests__/api/compliance/protocol-audit.test.ts

/**
 * Protocol Compliance Audit Tests
 *
 * Tests all API endpoints for HushhMCP protocol compliance:
 * 1. Firebase Auth (identity verification)
 * 2. BYOK Encryption (client-side)
 * 3. Consent Protocol (token validation)
 *
 * Per consent-protocol/docs/consent.md:
 * - Every data operation MUST have valid consent token
 * - Token scope MUST match required operation
 * - User ID in token MUST match requesting user
 */

import {
  createMockGET,
  createMockPOST,
  expectError,
  mockFetch,
} from "../../utils/test-helpers";

// Dynamic imports for route handlers (food/professional routes removed; use PKM)
let vaultGetRoute: { GET: Function };
let vaultCheckRoute: { GET: Function };
let vaultStatusRoute: { GET: Function; POST: Function };

beforeAll(async () => {
  vaultGetRoute = await import("../../../app/api/vault/get/route");
  vaultCheckRoute = await import("../../../app/api/vault/check/route");
  vaultStatusRoute = await import("../../../app/api/vault/status/route");
});

describe("🔐 Protocol Compliance Audit", () => {
  // =========================================================================
  // IDENTITY ENDPOINTS - Require Firebase Auth
  // =========================================================================
  describe("Identity Endpoints (require Firebase auth)", () => {
    describe("GET /api/vault/get", () => {
      it("should reject without Authorization header", async () => {
        process.env.NEXT_PUBLIC_APP_ENV = "production";

        const request = createMockGET("/api/vault/get", {
          userId: "test_user",
        });

        const response = await vaultGetRoute.GET(request);
        await expectError(response, 401, "AUTH_REQUIRED");

        process.env.NEXT_PUBLIC_APP_ENV = "development";
      });
    });

    describe("GET /api/vault/check", () => {
      it("should reject without Authorization header", async () => {
        process.env.NEXT_PUBLIC_APP_ENV = "production";

        const request = createMockGET("/api/vault/check", {
          userId: "test_user",
        });

        const response = await vaultCheckRoute.GET(request);
        await expectError(response, 401, "AUTH_REQUIRED");

        process.env.NEXT_PUBLIC_APP_ENV = "development";
      });
    });

    describe("GET /api/vault/status", () => {
      it("should reject without Authorization header", async () => {
        const request = createMockGET("/api/vault/status", {
          userId: "test_user",
          consentToken: "test_consent",
        });

        const response = await vaultStatusRoute.GET(request);
        await expectError(response, 401);
        const data = await response.json();
        expect(data.error).toContain("Missing Authorization header");
      });
    });

    describe("POST /api/vault/status", () => {
      it("should reject without Authorization header", async () => {
        const request = createMockPOST("/api/vault/status", {
          userId: "test_user",
          consentToken: "test_consent",
        });

        const response = await vaultStatusRoute.POST(request);
        await expectError(response, 401);
        const data = await response.json();
        expect(data.error).toContain("Missing Authorization header");
      });
    });
  });

  // =========================================================================
  // DEVELOPMENT MODE - Auto-grant behavior
  // =========================================================================
  describe("NEXT_PUBLIC_APP_ENV=development (auto-grant)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_ENV = "development";
    });

    it("should allow vault get in dev mode when route exists", async () => {
      mockFetch(null, 404);
      const request = createMockGET("/api/vault/get", { userId: "test_user" });
      const response = await vaultGetRoute.GET(request);
      expect(response.status).not.toBe(401);
    });
  });
});
