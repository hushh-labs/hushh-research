import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePickupEta } from "../use-pickup-eta";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

function pt(lat: number, lng: number): PlainLocationPoint {
  return {
    latitude: lat,
    longitude: lng,
    capturedAt: "2026-07-14T00:00:00.000Z",
    sourcePlatform: "web",
  } as PlainLocationPoint;
}
const HELPER = pt(40.75, -74.05);
const PICKUP = pt(40.76, -74.04);
const ETA: RouteEta = { etaSeconds: 240, distanceMeters: 1800 };

describe("usePickupEta", () => {
  it("seeds the ETA from seedEtaSeconds before any fetch", () => {
    const fetchEta = vi.fn().mockResolvedValue(ETA);
    const { result } = renderHook(() =>
      usePickupEta({ helperPoint: null, pickupPoint: null, seedEtaSeconds: 360, fetchEta }),
    );
    expect(result.current.status).toBe("seeded");
    expect(result.current.eta?.etaSeconds).toBe(360);
    expect(fetchEta).not.toHaveBeenCalled();
  });

  it("recomputes via fetchEta when both points are present", async () => {
    const fetchEta = vi.fn().mockResolvedValue(ETA);
    const { result } = renderHook(() =>
      usePickupEta({ helperPoint: HELPER, pickupPoint: PICKUP, seedEtaSeconds: null, fetchEta }),
    );
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(fetchEta).toHaveBeenCalledTimes(1);
    expect(result.current.eta).toEqual(ETA);
  });

  it("keeps the last-known ETA when a later fetch fails (never 'unavailable')", async () => {
    const fetchEta = vi
      .fn()
      .mockResolvedValueOnce(ETA)
      .mockRejectedValueOnce(new Error("network"));
    const { result, rerender } = renderHook(
      ({ helper }) =>
        usePickupEta({ helperPoint: helper, pickupPoint: PICKUP, seedEtaSeconds: null, fetchEta }),
      { initialProps: { helper: HELPER } },
    );
    await waitFor(() => expect(result.current.eta).toEqual(ETA));
    // Move far enough to force a recompute (~1.1 km), which will reject.
    rerender({ helper: pt(40.77, -74.05) });
    await waitFor(() => expect(result.current.status).toBe("stale"));
    expect(result.current.eta).toEqual(ETA); // retained
  });

  it("does not fetch when either point is missing", () => {
    const fetchEta = vi.fn().mockResolvedValue(ETA);
    renderHook(() =>
      usePickupEta({ helperPoint: HELPER, pickupPoint: null, seedEtaSeconds: null, fetchEta }),
    );
    expect(fetchEta).not.toHaveBeenCalled();
  });
});
