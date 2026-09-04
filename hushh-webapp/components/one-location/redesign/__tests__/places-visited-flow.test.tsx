// @vitest-environment jsdom
/**
 * "Places you've been" is where the two halves of a rating meet.
 *
 * The star comes from the server, the note from the owner's vault, and this
 * screen is the only place they are ever in the same memory. The assertions
 * below are about that join and about what happens when one half is missing --
 * a locked vault must cost the note and nothing else.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  listPlaceRatings: vi.fn(),
  deletePlaceRating: vi.fn(),
}));
const visitNotes = vi.hoisted(() => ({
  loadVisitNotes: vi.fn(),
  removeVisitNote: vi.fn(),
}));
const auth = vi.hoisted(() => ({ user: { uid: "user-1" } as { uid: string } | null }));
const vault = vi.hoisted(() => ({
  vaultKey: "vault-key" as string | null,
  vaultOwnerToken: "owner-token" as string | null,
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { promise: vi.fn() },
}));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: service }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/lib/one-location/visit-notes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/one-location/visit-notes")>();
  return {
    ...actual,
    loadVisitNotes: visitNotes.loadVisitNotes,
    removeVisitNote: visitNotes.removeVisitNote,
  };
});

import { PlacesVisitedFlow } from "@/components/one-location/redesign/places-visited-flow";

const rating = (overrides: Record<string, unknown> = {}) => ({
  id: "r1",
  placeId: "ChIJbagmaker",
  placeLabel: "Bag Maker",
  rating: 4,
  countsTowardAverage: true,
  consentVersion: "one-location-place-rating-v1",
  consentCurrent: true,
  visitCount: 1,
  revision: 1,
  googleReviewUrl:
    "https://search.google.com/local/writereview?placeid=ChIJbagmaker",
  ...overrides,
});

describe("PlacesVisitedFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = { uid: "user-1" };
    vault.vaultKey = "vault-key";
    vault.vaultOwnerToken = "owner-token";
    service.listPlaceRatings.mockResolvedValue([]);
    service.deletePlaceRating.mockResolvedValue(undefined);
    visitNotes.loadVisitNotes.mockResolvedValue([]);
    visitNotes.removeVisitNote.mockResolvedValue([]);
  });

  it("joins the server's star with the vault's note, on the device", async () => {
    service.listPlaceRatings.mockResolvedValue([rating()]);
    visitNotes.loadVisitNotes.mockResolvedValue([
      {
        placeId: "ChIJbagmaker",
        label: "Bag Maker",
        rating: 4,
        note: "Quick and friendly.",
        visitedAt: null,
        ratedAt: "2026-08-31T12:00:00.000Z",
      },
    ]);

    render(<PlacesVisitedFlow />);

    expect(await screen.findByText("Bag Maker")).toBeInTheDocument();
    expect(screen.getByText("Quick and friendly.")).toBeInTheDocument();
    expect(screen.getByText("4 out of 5")).toBeInTheDocument();
  });

  it("prefers the server's label over a stale vault copy", async () => {
    service.listPlaceRatings.mockResolvedValue([
      rating({ placeLabel: "Bag Maker" }),
    ]);
    visitNotes.loadVisitNotes.mockResolvedValue([
      {
        placeId: "ChIJbagmaker",
        label: "An old name",
        rating: 4,
        note: null,
        visitedAt: null,
        ratedAt: "2026-08-31T12:00:00.000Z",
      },
    ]);

    render(<PlacesVisitedFlow />);

    expect(await screen.findByText("Bag Maker")).toBeInTheDocument();
    expect(screen.queryByText("An old name")).toBeNull();
  });

  it("still lists the ratings when the vault is locked", async () => {
    // The stars are the server's and are still theirs to read. Only the note
    // lives behind the vault.
    vault.vaultKey = null;
    service.listPlaceRatings.mockResolvedValue([rating()]);

    render(<PlacesVisitedFlow />);

    expect(await screen.findByText("Bag Maker")).toBeInTheDocument();
    expect(
      screen.getByText("Unlock your vault to see your note."),
    ).toBeInTheDocument();
    expect(visitNotes.loadVisitNotes).not.toHaveBeenCalled();
  });

  it("says what to do when nothing has been rated yet", async () => {
    render(<PlacesVisitedFlow />);

    expect(await screen.findByText("Nothing rated yet")).toBeInTheDocument();
  });

  it("removes both halves together", async () => {
    // A note that outlives its rating means the place comes back with no stars
    // the next time this screen loads.
    service.listPlaceRatings.mockResolvedValue([rating()]);
    render(<PlacesVisitedFlow />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove your rating for Bag Maker",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove", hidden: true }),
    );

    await waitFor(() =>
      expect(service.deletePlaceRating).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        placeId: "ChIJbagmaker",
      }),
    );
    await waitFor(() =>
      expect(visitNotes.removeVisitNote).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: "ChIJbagmaker" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Bag Maker")).toBeNull());
  });

  it("does not delete the server rating when the vault note cannot be removed", async () => {
    service.listPlaceRatings.mockResolvedValue([rating()]);
    visitNotes.removeVisitNote.mockRejectedValue(new Error("vault unavailable"));
    render(<PlacesVisitedFlow />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove your rating for Bag Maker",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove", hidden: true }),
    );

    await waitFor(() => expect(visitNotes.removeVisitNote).toHaveBeenCalled());
    expect(service.deletePlaceRating).not.toHaveBeenCalled();
    expect(screen.getByText("Bag Maker")).toBeInTheDocument();
  });

  it("links each place to its own Google composer", async () => {
    service.listPlaceRatings.mockResolvedValue([rating()]);

    render(<PlacesVisitedFlow />);

    const link = await screen.findByRole("link", {
      name: "Review Bag Maker on Google",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://search.google.com/local/writereview?placeid=ChIJbagmaker",
    );
  });

  it("offers a retry rather than a blank screen when the load fails", async () => {
    service.listPlaceRatings.mockRejectedValue(new Error("offline"));

    render(<PlacesVisitedFlow />);

    expect(
      await screen.findByText("Couldn't load your places. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
