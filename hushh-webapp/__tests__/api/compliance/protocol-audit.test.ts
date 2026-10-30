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
  expectError,
  mockFetch,
} from "../../utils/test-helpers";

// Dynamic imports for route handlers (food/professional routes removed; use PKM)
let vaultGetRoute: { GET: Function };
let vaultCheckRoute: { GET: Function };

beforeAll(async () => {
  vaultGetRoute = await import("../../../app/api/vault/get/route");
  vaultCheckRoute = await import("../../../app/api/vault/check/route");
});

describe("🔐 Protocol Compliance Audit", () => {
  // =========================================================================
  // VAULT WRITE ENDPOINTS - Require Consent Token
  // =========================================================================
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

      it("forwards a Firebase bearer to the backend without requiring a second Admin SDK", async () => {
        process.env.NEXT_PUBLIC_APP_ENV = "production";
        const authorization = "Bearer browser-issued-firebase-token";
        mockFetch({ wrappers: [], vaultKeyHash: "commitment" }, 200);

        const response = await vaultGetRoute.GET(
          createMockGET(
            "/api/vault/get",
            { userId: "test_user" },
            { Authorization: authorization },
          ),
        );

        expect(response.status).toBe(200);
        const [, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(new Headers(options.headers).get("Authorization")).toBe(authorization);

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
