import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Profile settings row is gated on this flag. A dark backend answers 404 on
 * every owner route, so a row that renders without the flag would put a dead
 * end inside a settings list — these cases pin the "unset means off" default
 * that prevents that.
 */
const ENV_KEY = "NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED";

async function readFlag(): Promise<boolean> {
  vi.resetModules();
  const { isWalletCardEntryEnabled } = await import(
    "@/components/wallet-card/wallet-card-entry"
  );
  return isWalletCardEntryEnabled();
}

describe("isWalletCardEntryEnabled", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("is off when the flag is unset", async () => {
    await expect(readFlag()).resolves.toBe(false);
  });

  it("is off when the flag is empty or whitespace", async () => {
    process.env[ENV_KEY] = "   ";
    await expect(readFlag()).resolves.toBe(false);
  });

  it.each(["true", "TRUE", "1", "yes", "on", " True "])(
    "is on for the truthy value %j",
    async (value) => {
      process.env[ENV_KEY] = value;
      await expect(readFlag()).resolves.toBe(true);
    },
  );

  it.each(["false", "0", "no", "off", "disabled", "maybe"])(
    "is off for the non-truthy value %j",
    async (value) => {
      process.env[ENV_KEY] = value;
      await expect(readFlag()).resolves.toBe(false);
    },
  );
});
