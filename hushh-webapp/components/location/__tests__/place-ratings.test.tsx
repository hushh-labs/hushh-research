// @vitest-environment jsdom
/**
 * Ratings: hidden behind "Ratings aren't available for your account yet."
 * unless the build gate and the server both admit the account; when they do,
 * only PLACE ratings render -- never anything about a person.
 */

import fs from "node:fs";
import path from "node:path";

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  listPlaceRatings: vi.fn(),
  listRateableVisits: vi.fn(),
  ratePlace: vi.fn(),
  deletePlaceRating: vi.fn(),
}));
const availability = vi.hoisted(() => ({ build: true }));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const resource = vi.hoisted(() => ({
  readPresentation: vi.fn(() => null),
  invalidate: vi.fn(),
  load: vi.fn(async (_uid: string, loader: () => Promise<unknown>) => loader()),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/one/location",
  useSearchParams: () => new URLSearchParams("action=ratings"),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "user-1",
    user: { uid: "user-1" },
    isAuthenticated: true,
    loading: false,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "owner-token", vaultKey: "vault-key" }),
}));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: service }));
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: resource,
}));
vi.mock("@/lib/one-location/nearby-check-in-availability", () => ({
  isOneLocationNearbyCheckInAvailable: () => availability.build,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: toast }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));

import {
  PlaceRatings,
  RATINGS_UNAVAILABLE_MESSAGE,
  ratingsCohortFromCapabilities,
} from "@/components/location/ratings/place-ratings";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import { ApiError } from "@/lib/services/api-client";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../ratings/place-ratings.tsx"),
  "utf8",
);

function rating(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    placeId: "ChIJcafe",
    placeLabel: "Third Wave Coffee",
    rating: 4,
    countsTowardAverage: true,
    consentVersion: "one-location-place-rating-v1",
    consentCurrent: true,
    visitCount: 1,
    revision: 1,
    ...overrides,
  };
}

describe("ratingsCohortFromCapabilities", () => {
  it("honours an explicit boolean cohort flag and stays unknown otherwise", () => {
    expect(ratingsCohortFromCapabilities(null)).toBeNull();
    expect(
      ratingsCohortFromCapabilities({ canShareLocation: true }),
    ).toBeNull();
    expect(ratingsCohortFromCapabilities({ nearbyCheckInEnabled: false })).toBe(
      false,
    );
    expect(ratingsCohortFromCapabilities({ canRatePlaces: true })).toBe(true);
  });
});

describe("PlaceRatings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceSessionStore.getState().reset();
    availability.build = true;
    resource.readPresentation.mockReturnValue(null);
    service.listPlaceRatings.mockResolvedValue([rating()]);
    service.listRateableVisits.mockResolvedValue([]);
  });

  it("hides ratings entirely when the build gate is off, without asking the server", async () => {
    availability.build = false;
    render(<PlaceRatings />);
    expect(screen.getByText(RATINGS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByTestId("one-location-ratings")).toHaveAttribute(
      "data-ratings-available",
      "false",
    );
    expect(screen.queryByTestId("place-ratings")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(service.listPlaceRatings).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Third Wave Coffee");
  });

  it("hides ratings when the server refuses the account with NEARBY_PRESENCE_UNAVAILABLE", async () => {
    service.listPlaceRatings.mockRejectedValue(
      new ApiError("Not found", 404, {
        detail: {
          code: "NEARBY_PRESENCE_UNAVAILABLE",
          message: "Nearby check-in is not available on this account yet.",
        },
      }),
    );
    render(<PlaceRatings />);
    expect(
      await screen.findByText(RATINGS_UNAVAILABLE_MESSAGE),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("place-ratings")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("hides ratings when the viewer capabilities carry an explicit cohort flag of false", () => {
    resource.readPresentation.mockReturnValue({
      viewerCapabilities: { nearbyCheckInEnabled: false },
    } as never);
    render(<PlaceRatings />);
    expect(screen.getByText(RATINGS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(service.listPlaceRatings).not.toHaveBeenCalled();
  });

  it("lists place ratings, and only places, when the account is admitted", async () => {
    render(<PlaceRatings />);
    const list = await screen.findByTestId("place-ratings");
    expect(list).toHaveTextContent("Third Wave Coffee");
    expect(list).toHaveTextContent("4 of 5");
    expect(screen.getByTestId("one-location-ratings")).toHaveAttribute(
      "data-ratings-available",
      "true",
    );
    expect(screen.getByText(/Places only — never people/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/rate (a|this) person/i);
  });

  it("switches to unavailable when the voice tool answers unsupported", async () => {
    render(<PlaceRatings />);
    await screen.findByTestId("place-ratings");
    act(() => {
      useVoiceSessionStore.getState().emitToolResult("list_my_place_ratings", {
        status: "unsupported",
        reason_code: "ratings_not_available",
        spoken_facts: [RATINGS_UNAVAILABLE_MESSAGE],
      });
    });
    await waitFor(() =>
      expect(screen.getByText(RATINGS_UNAVAILABLE_MESSAGE)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("place-ratings")).toBeNull();
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Ratings"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
  });
});
