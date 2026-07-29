import { afterEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = "@/lib/portfolio-share/token";
vi.mock("server-only", () => ({}), { virtual: true });

describe("portfolio share token secret handling", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPortfolioShareSecret = process.env.PORTFOLIO_SHARE_SECRET;
  const originalSessionSecret = process.env.SESSION_SECRET;

  afterEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalPortfolioShareSecret === undefined) {
      delete process.env.PORTFOLIO_SHARE_SECRET;
    } else {
      process.env.PORTFOLIO_SHARE_SECRET = originalPortfolioShareSecret;
    }

    if (originalSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSessionSecret;
    }
  });

  it("returns null when no token is provided", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PORTFOLIO_SHARE_SECRET;
    delete process.env.SESSION_SECRET;

    const { verifyPortfolioShareToken } = await import(MODULE_PATH);
    const verifiedPayload = await verifyPortfolioShareToken("");

    expect(verifiedPayload).toBeNull();
  });

  it("fails closed in production when signing secret is missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PORTFOLIO_SHARE_SECRET;
    delete process.env.SESSION_SECRET;

    const { createPortfolioShareToken } = await import(MODULE_PATH);

    await expect(createPortfolioShareToken({ portfolioValue: 1 })).rejects.toThrow(
      "Missing portfolio share signing secret",
    );
  });
});

// ---------------------------------------------------------------------------
// Token revocation contract
// ---------------------------------------------------------------------------
// verifyPortfolioShareToken returns null for any token that fails
// cryptographic verification — the caller must treat null as an
// explicit unauthorised / revoked posture and never grant access.

describe("portfolio share token — revocation contract", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPortfolioShareSecret = process.env.PORTFOLIO_SHARE_SECRET;
  const originalSessionSecret = process.env.SESSION_SECRET;

  afterEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalPortfolioShareSecret === undefined) {
      delete process.env.PORTFOLIO_SHARE_SECRET;
    } else {
      process.env.PORTFOLIO_SHARE_SECRET = originalPortfolioShareSecret;
    }
    if (originalSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSessionSecret;
    }
  });

  it("returns null for a plaintext revoked token identifier", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PORTFOLIO_SHARE_SECRET;
    delete process.env.SESSION_SECRET;

    const { verifyPortfolioShareToken } = await import(MODULE_PATH);

    expect(await verifyPortfolioShareToken("test_revoked_token_id_001")).toBeNull();
  });

  it("returns null for a dot-delimited string that mimics JWT structure but carries no valid signature", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PORTFOLIO_SHARE_SECRET;
    delete process.env.SESSION_SECRET;

    const { verifyPortfolioShareToken } = await import(MODULE_PATH);

    expect(await verifyPortfolioShareToken("test.revoked.sig")).toBeNull();
  });

  it("returns null for a well-formed JWT structure carrying an invalid HMAC signature (simulates revocation via key rotation)", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PORTFOLIO_SHARE_SECRET;
    delete process.env.SESSION_SECRET;

    const { verifyPortfolioShareToken } = await import(MODULE_PATH);

    // Valid base64url header {"alg":"HS256"} + payload {"sub":"test"} but invalid signature.
    // jwtVerify rejects the HMAC mismatch and the catch block returns null.
    const fakeJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.invalidsignaturevalue";

    expect(await verifyPortfolioShareToken(fakeJwt)).toBeNull();
  });

  it("returns null for an empty-string token (no implicit access on blank input)", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PORTFOLIO_SHARE_SECRET;
    delete process.env.SESSION_SECRET;

    const { verifyPortfolioShareToken } = await import(MODULE_PATH);

    expect(await verifyPortfolioShareToken("")).toBeNull();
  });
});
