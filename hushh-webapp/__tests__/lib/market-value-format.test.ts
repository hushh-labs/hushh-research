import { afterEach, describe, expect, it } from "vitest";

import { resetMarketCurrency, setMarketCurrencyRate, setMarketCurrencyRegion } from "@/lib/kai/market-currency-store";
import { formatCompactNumber, formatCurrency, formatMoney, resolveDisplayMoney } from "@/lib/kai/market-value-format";

const US = { region: "US", rate: null } as const;
const IN = { region: "IN", rate: 88.5 } as const;

afterEach(() => resetMarketCurrency());

describe("market currency formatting", () => {
  it("keeps US output identical to the previous en-US dollar format", () => {
    const legacy = (value: number, currency = "USD") =>
      new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
    for (const value of [0, 12.5, -1234.567, 1_234_567.891]) {
      expect(formatMoney(value, US)).toBe(legacy(value));
      expect(formatCurrency(value)).toBe(legacy(value));
    }
    expect(formatMoney(1234.5, US, { source: "EUR" })).toBe(legacy(1234.5, "EUR"));
    expect(formatCompactNumber(1_250_000)).toBe(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(1_250_000),
    );
    expect(formatMoney(1234.5, US, { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe("$1,234.50");
    expect(formatMoney(1500, US, { maximumFractionDigits: 0 })).toBe("$1,500");
    expect(formatCurrency(null)).toBe("Price unavailable");
    expect(formatCurrency(Number.NaN)).toBe("Price unavailable");
  });

  it("converts dollars to rupees at the daily rate with lakh and crore grouping", () => {
    expect(formatMoney(1000, IN)).toBe("₹88,500.00");
    expect(formatMoney(100_000, IN, { maximumFractionDigits: 0 })).toBe("₹88,50,000");
    expect(formatMoney(10_000_000, IN, { maximumFractionDigits: 0 })).toBe("₹88,50,00,000");
    expect(formatMoney(1_000_000, IN, { notation: "compact" })).toMatch(/^₹8\.9Cr$/);
    expect(resolveDisplayMoney(10, "usd", IN)).toMatchObject({ amount: 885, currency: "INR" });
  });

  it("never converts a value that is already in rupees or in another currency", () => {
    expect(formatMoney(2500, IN, { source: "INR", maximumFractionDigits: 2 })).toBe("₹2,500.00");
    expect(resolveDisplayMoney(2500, "INR", IN).amount).toBe(2500);
    expect(resolveDisplayMoney(100, "EUR", IN)).toMatchObject({ amount: 100, currency: "EUR" });
    // US mode leaves every currency as it is, including rupees.
    expect(formatMoney(2500, US, { source: "INR" })).toBe(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(2500),
    );
  });

  it("stays in dollars in India mode until a rate exists, never guessing one", () => {
    expect(formatMoney(1000, { region: "IN", rate: null })).toBe("$1,000.00");
    expect(formatMoney(1000, { region: "IN", rate: 0 })).toBe("$1,000.00");
  });

  it("follows the stored mode for the outside-React helpers", () => {
    setMarketCurrencyRegion("user_a", "IN");
    setMarketCurrencyRate({ rate: 90, asOf: "2026-11-12", stale: false });
    expect(formatCurrency(100)).toBe("₹9,000.00");
    setMarketCurrencyRegion("user_a", "US");
    expect(formatCurrency(100)).toBe("$100.00");
  });
});
