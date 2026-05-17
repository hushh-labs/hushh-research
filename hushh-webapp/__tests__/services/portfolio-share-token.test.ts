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
