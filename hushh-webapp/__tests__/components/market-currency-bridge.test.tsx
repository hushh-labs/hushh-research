import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getKaiUsdInrRate = vi.fn();
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "user_a", phoneNumber: null }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/kai" }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getKaiUsdInrRate: (...args: unknown[]) => getKaiUsdInrRate(...args) } }));
vi.mock("@/lib/kai/kai-financial-resource", () => ({ KaiFinancialResourceService: { peek: () => null } }));

import { MarketCurrencyBridge } from "@/components/kai/shared/market-currency-bridge";
import { resetMarketCurrency } from "@/lib/kai/market-currency-store";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";

function Probe() {
  const { format, region, selectRegion } = useMarketCurrency();
  return (
    <div>
      <p data-testid="value">{format(1000)}</p>
      <p data-testid="native">{format(2500, { source: "INR" })}</p>
      <button onClick={() => selectRegion(region === "IN" ? "US" : "IN")}>switch</button>
    </div>
  );
}

describe("market currency bridge", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetMarketCurrency();
    getKaiUsdInrRate.mockReset();
  });
  afterEach(() => resetMarketCurrency());

  it("keeps dollars in US mode and never asks for a rate", async () => {
    window.localStorage.setItem("kai_market_region_v1:user_a", "US");
    render(<><MarketCurrencyBridge /><Probe /></>);
    await act(async () => {});
    expect(screen.getByTestId("value").textContent).toBe("$1,000.00");
    expect(getKaiUsdInrRate).not.toHaveBeenCalled();
  });

  it("shows rupees on every screen once India is selected and the rate loads", async () => {
    getKaiUsdInrRate.mockResolvedValue({ base: "USD", quote: "INR", rate: 90, as_of: "2026-11-12", stale: false });
    window.localStorage.setItem("kai_market_region_v1:user_a", "IN");
    render(<><MarketCurrencyBridge /><Probe /></>);
    await act(async () => {});
    expect(getKaiUsdInrRate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("value").textContent).toBe("₹90,000.00");
    expect(screen.getByTestId("native").textContent).toBe("₹2,500.00"); // already rupees: not converted again
  });

  it("stays in dollars when the rate is unavailable instead of guessing one", async () => {
    getKaiUsdInrRate.mockRejectedValue(new Error("Exchange rate unavailable: 503"));
    window.localStorage.setItem("kai_market_region_v1:user_a", "IN");
    render(<><MarketCurrencyBridge /><Probe /></>);
    await act(async () => {});
    expect(screen.getByTestId("value").textContent).toBe("$1,000.00");
  });

  it("applies the market chosen on the Market page everywhere and remembers it", async () => {
    getKaiUsdInrRate.mockResolvedValue({ base: "USD", quote: "INR", rate: 90, as_of: "2026-11-12", stale: false });
    window.localStorage.setItem("kai_market_region_v1:user_a", "US");
    render(<><MarketCurrencyBridge /><Probe /></>);
    await act(async () => {});
    await act(async () => screen.getByText("switch").click());
    expect(screen.getByTestId("value").textContent).toBe("₹90,000.00");
    expect(window.localStorage.getItem("kai_market_region_v1:user_a")).toBe("IN");
  });
});
