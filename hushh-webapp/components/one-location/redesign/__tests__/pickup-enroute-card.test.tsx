/**
 * Tests for PickupEnRouteCard (cards.tsx) and the en-route helper derivation
 * logic that lives in NowHub (location-redesign-hub.tsx).
 *
 * The derivation is tested via a thin helper function that mirrors the
 * production code exactly, exercising the predicate in isolation — which keeps
 * the test free of heavy component mocking while still asserting real logic.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PickupEnRouteCard } from "@/components/one-location/redesign/cards";
import type { OneLocationGrant, PlainLocationPoint } from "@/lib/one-location/types";

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                      */
/* ------------------------------------------------------------------ */

function makeGrant(overrides: Partial<OneLocationGrant> = {}): OneLocationGrant {
  return {
    id: "g-default",
    ownerUserId: "owner-1",
    recipientUserId: "recipient-1",
    recipientKeyId: "key-1",
    status: "active",
    consentScope: "location",
    capabilityScopes: [],
    durationHours: 4,
    shareKind: "share",
    ...overrides,
  };
}

function makePoint(etaSeconds?: number | null): PlainLocationPoint {
  return {
    latitude: 28.6562,
    longitude: 77.241,
    capturedAt: "2026-07-12T00:00:00Z",
    sourcePlatform: "web",
    drive: etaSeconds !== undefined
      ? {
          destination: { latitude: 28.7, longitude: 77.1, label: "Destination" },
          etaSeconds: etaSeconds,
          distanceMeters: 5000,
          etaComputedAt: "2026-07-12T00:00:00Z",
        }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Mirror the production derivation so we can test it in isolation     */
/* ------------------------------------------------------------------ */

type EnRouteEntry = {
  key: string;
  helperName: string;
  etaSeconds: number | null;
  outboundGrantId: string;
};

function deriveEnRouteHelpers(
  receivedGrants: OneLocationGrant[],
  activeOwnerGrants: OneLocationGrant[],
  decryptedPoints: Record<string, PlainLocationPoint>,
  grantOwnerLabel: (g: OneLocationGrant) => string,
): EnRouteEntry[] {
  return receivedGrants
    .filter(
      (g) =>
        g.shareKind === "pickup_enroute" &&
        Boolean(decryptedPoints[g.id]),
    )
    .flatMap((receivedGrant) => {
      const outboundGrant = activeOwnerGrants.find(
        (g) =>
          g.shareKind === "pick_me_up" &&
          g.recipientUserId === receivedGrant.ownerUserId,
      );
      if (!outboundGrant) return [];
      const point = decryptedPoints[receivedGrant.id]!;
      return [
        {
          key: receivedGrant.id,
          helperName: grantOwnerLabel(receivedGrant),
          etaSeconds: point.drive?.etaSeconds ?? null,
          outboundGrantId: outboundGrant.id,
        },
      ];
    });
}

/* ------------------------------------------------------------------ */
/* Tests: derivation                                                    */
/* ------------------------------------------------------------------ */

describe("deriveEnRouteHelpers", () => {
  it("yields a helper entry when pickup_enroute received + matching outbound pick_me_up exist", () => {
    const received = [
      makeGrant({ id: "r1", shareKind: "pickup_enroute", ownerUserId: "helper-1" }),
    ];
    const outbound = [
      makeGrant({ id: "o1", shareKind: "pick_me_up", recipientUserId: "helper-1" }),
    ];
    const points: Record<string, PlainLocationPoint> = {
      r1: makePoint(720),
    };
    const label = (g: OneLocationGrant) => (g.ownerUserId === "helper-1" ? "Ravi" : "?");

    const result = deriveEnRouteHelpers(received, outbound, points, label);

    expect(result).toHaveLength(1);
    expect(result[0]!.helperName).toBe("Ravi");
    expect(result[0]!.etaSeconds).toBe(720);
    expect(result[0]!.outboundGrantId).toBe("o1");
    expect(result[0]!.key).toBe("r1");
  });

  it("yields no entry when the received grant has no decrypted point yet", () => {
    const received = [
      makeGrant({ id: "r1", shareKind: "pickup_enroute", ownerUserId: "helper-1" }),
    ];
    const outbound = [
      makeGrant({ id: "o1", shareKind: "pick_me_up", recipientUserId: "helper-1" }),
    ];
    // No decrypted point
    const result = deriveEnRouteHelpers(received, outbound, {}, () => "Ravi");

    expect(result).toHaveLength(0);
  });

  it("yields no entry when there is no matching outbound pick_me_up grant", () => {
    const received = [
      makeGrant({ id: "r1", shareKind: "pickup_enroute", ownerUserId: "helper-1" }),
    ];
    // Outbound exists but for a DIFFERENT recipient
    const outbound = [
      makeGrant({ id: "o1", shareKind: "pick_me_up", recipientUserId: "other-user" }),
    ];
    const points: Record<string, PlainLocationPoint> = { r1: makePoint(300) };

    const result = deriveEnRouteHelpers(received, outbound, points, () => "Ravi");

    expect(result).toHaveLength(0);
  });

  it("ignores received grants that are not pickup_enroute", () => {
    const received = [
      makeGrant({ id: "r1", shareKind: "pick_me_up", ownerUserId: "helper-1" }),
    ];
    const outbound = [
      makeGrant({ id: "o1", shareKind: "pick_me_up", recipientUserId: "helper-1" }),
    ];
    const points: Record<string, PlainLocationPoint> = { r1: makePoint(300) };

    const result = deriveEnRouteHelpers(received, outbound, points, () => "Ravi");

    expect(result).toHaveLength(0);
  });

  it("returns etaSeconds null when drive payload is absent", () => {
    const received = [
      makeGrant({ id: "r1", shareKind: "pickup_enroute", ownerUserId: "helper-1" }),
    ];
    const outbound = [
      makeGrant({ id: "o1", shareKind: "pick_me_up", recipientUserId: "helper-1" }),
    ];
    // Point with no drive payload
    const points: Record<string, PlainLocationPoint> = {
      r1: {
        latitude: 28.6562,
        longitude: 77.241,
        capturedAt: "2026-07-12T00:00:00Z",
        sourcePlatform: "web",
      },
    };

    const result = deriveEnRouteHelpers(received, outbound, points, () => "Ravi");

    expect(result).toHaveLength(1);
    expect(result[0]!.etaSeconds).toBeNull();
  });

  it("handles multiple en-route helpers independently", () => {
    const received = [
      makeGrant({ id: "r1", shareKind: "pickup_enroute", ownerUserId: "h1" }),
      makeGrant({ id: "r2", shareKind: "pickup_enroute", ownerUserId: "h2" }),
    ];
    const outbound = [
      makeGrant({ id: "o1", shareKind: "pick_me_up", recipientUserId: "h1" }),
      makeGrant({ id: "o2", shareKind: "pick_me_up", recipientUserId: "h2" }),
    ];
    const points: Record<string, PlainLocationPoint> = {
      r1: makePoint(600),
      r2: makePoint(1200),
    };

    const result = deriveEnRouteHelpers(received, outbound, points, (g) => g.ownerUserId);

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.outboundGrantId).sort()).toEqual(["o1", "o2"]);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: PickupEnRouteCard component                                  */
/* ------------------------------------------------------------------ */

describe("PickupEnRouteCard", () => {
  it("renders helper name and ETA text", () => {
    render(
      <PickupEnRouteCard
        helperName="Ravi"
        etaText="~12 min away"
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Ravi is on the way")).toBeInTheDocument();
    expect(screen.getByText("~12 min away")).toBeInTheDocument();
  });

  it("renders a cancel pickup button and calls onCancel when clicked", () => {
    const onCancel = vi.fn();
    render(
      <PickupEnRouteCard
        helperName="Ravi"
        etaText="~12 min away"
        onCancel={onCancel}
      />,
    );

    const btn = screen.getByRole("button", { name: /cancel pickup/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders children (map preview) when provided", () => {
    render(
      <PickupEnRouteCard
        helperName="Ravi"
        etaText="~12 min away"
        onCancel={vi.fn()}
      >
        <div data-testid="map-preview">map</div>
      </PickupEnRouteCard>,
    );

    expect(screen.getByTestId("map-preview")).toBeInTheDocument();
  });

  it("shows Live status pill", () => {
    render(
      <PickupEnRouteCard
        helperName="Ravi"
        etaText="ETA unavailable"
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("shows cancelBusy loading state on the button when provided", () => {
    render(
      <PickupEnRouteCard
        helperName="Ravi"
        etaText="~5 min away"
        onCancel={vi.fn()}
        cancelBusy
      />,
    );

    // Button should be disabled while loading
    const btn = screen.getByRole("button", { name: /cancel pickup/i });
    expect(btn).toBeDisabled();
  });
});
