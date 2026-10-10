import { beforeEach, describe, expect, it, vi } from "vitest";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-client", () => ({ apiJson }));

import { DriveRequestPricingService } from "@/lib/services/drive-request-pricing-service";

const owner = "11111111-1111-4111-8111-111111111111";

describe("Drive request pricing service", () => {
  beforeEach(() => apiJson.mockReset());

  it("uses vault auth and fixed quote versions for future requests", async () => {
    apiJson.mockResolvedValueOnce({ enabled: false, amountCents: 1000, version: 2 });
    expect(await DriveRequestPricingService.owner("vault")).toEqual({ enabled: false, amountCents: 1000, version: 2 });
    expect(apiJson).toHaveBeenCalledWith("/api/connectors/google_drive/sharing/pricing", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });

    apiJson.mockResolvedValueOnce({ enabled: true, amountCents: 2500, version: 3 });
    expect(await DriveRequestPricingService.save("vault", {
      enabled: true, amountCents: 2500, expectedVersion: 2,
    })).toMatchObject({ amountCents: 2500, version: 3 });
    expect(apiJson).toHaveBeenLastCalledWith("/api/connectors/google_drive/sharing/pricing", {
      method: "PUT",
      headers: { Authorization: "Bearer vault", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, amountCents: 2500, expectedVersion: 2 }),
    });

    apiJson.mockResolvedValueOnce({ amountCents: 2500, version: 3, paymentRequired: true, payoutReady: false });
    expect(await DriveRequestPricingService.quote("vault", owner)).toMatchObject({ amountCents: 2500, version: 3, payoutReady: false });
    expect(apiJson).toHaveBeenLastCalledWith(
      `/api/connectors/google_drive/sharing/quote?ownerPersonRef=${owner}`,
      { headers: { Authorization: "Bearer vault" }, cache: "no-store" },
    );
  });

  it("rejects malformed prices and quote replies before they reach the UI", async () => {
    await expect(DriveRequestPricingService.save("vault", {
      enabled: true, amountCents: 1050, expectedVersion: 1,
    })).rejects.toThrow("whole-dollar");
    expect(apiJson).not.toHaveBeenCalled();
    apiJson.mockResolvedValueOnce({ amountCents: 0, version: 1, paymentRequired: true, payoutReady: true });
    await expect(DriveRequestPricingService.quote("vault", owner)).rejects.toThrow("Invalid Drive pricing response");
    apiJson.mockResolvedValueOnce({ amountCents: 1000, version: -1, paymentRequired: true, payoutReady: true });
    await expect(DriveRequestPricingService.quote("vault", owner)).rejects.toThrow("Invalid Drive pricing response");
  });
});
