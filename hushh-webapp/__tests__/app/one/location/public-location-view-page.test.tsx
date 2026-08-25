import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePublicInvite: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "public-token" }),
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    resolvePublicInvite: mocks.resolvePublicInvite,
  },
}));

import PublicLocationViewPageClient from "@/app/one/location/view/[token]/page-client";

/**
 * Expiry is relative to the run, not a literal date. The fixture used to pin
 * 2026-05-20, which silently became a past timestamp — harmless while nothing
 * compared it to the clock, and an "already expired" link the moment the
 * countdown landed.
 */
function invitePayload(
  expiresInMs: number,
  ownerLabel: string = "Neelesh Meena",
) {
  return {
    invite: {
      status: "active",
      durationHours: 1,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      ownerLabel,
      locationAvailable: true,
    },
    publicLocation: {
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 18,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      sourcePlatform: "web",
    },
  };
}

describe("PublicLocationViewPageClient", () => {
  beforeEach(() => {
    mocks.resolvePublicInvite.mockResolvedValue(invitePayload(2 * 60 * 60 * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a shared location directly without visitor intake", async () => {
    render(<PublicLocationViewPageClient />);

    await waitFor(() =>
      expect(mocks.resolvePublicInvite).toHaveBeenCalledWith("public-token"),
    );

    const map = await screen.findByTitle("Live location map");
    fireEvent.click(
      screen.getByRole("button", { name: "Recenter live location map" }),
    );

    expect(screen.getByTitle("Live location map")).not.toBe(map);
    expect(mocks.resolvePublicInvite).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText("Your name")).toBeNull();
    expect(screen.queryByPlaceholderText("Phone number")).toBeNull();
    expect(screen.queryByPlaceholderText("Optional message")).toBeNull();
  });

  it("names the person who shared, rather than a category", async () => {
    // Every shared link opened as "A trusted person" because
    // `create_public_invite` never wrote `metadata.owner_safe_label` — the one
    // field the recipient payload reads for a name. The recipient is deciding
    // whether they know the sender; a category cannot answer that.
    render(<PublicLocationViewPageClient />);

    expect(
      await screen.findByText("Neelesh Meena's live location"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Neelesh Meena is sharing their live location with you/),
    ).toBeTruthy();
    expect(screen.getByText("Neelesh Meena's location")).toBeTruthy();
    expect(screen.queryByText(/A trusted person/)).toBeNull();
  });

  it("keeps a generic line when the sender resolves to no name at all", async () => {
    // The server's fallback is a sentence fragment, so it must never be
    // possessive'd into a title: "A trusted person's live location".
    mocks.resolvePublicInvite.mockResolvedValue(
      invitePayload(30 * 60 * 1000, "A trusted person"),
    );
    render(<PublicLocationViewPageClient />);

    expect(await screen.findByText("Shared location")).toBeTruthy();
    expect(
      screen.getByText(/A trusted person is sharing their live location/),
    ).toBeTruthy();
    expect(screen.queryByText(/A trusted person's/)).toBeNull();
  });

  it("marks the map Live rather than describing who could open the link", async () => {
    render(<PublicLocationViewPageClient />);

    const badge = await screen.findByText("Live");
    expect(badge).toBeTruthy();
    // Green, and specifically the success role's solid fill — not the accent,
    // which follows a per-account colour preference and rendered this status
    // gold for anyone who had changed it.
    const chip = badge.closest("div");
    expect(chip?.className).toContain("bg-[color:var(--app-success)]");
    expect(chip?.className).not.toContain("var(--app-accent)");
    expect(screen.queryByText("Public location")).toBeNull();
  });

  it("counts the window down instead of printing a timestamp to subtract", async () => {
    mocks.resolvePublicInvite.mockResolvedValue(invitePayload(90 * 60 * 1000));
    render(<PublicLocationViewPageClient />);

    // "1h 29m" rather than the old "Expires <date>" + "1h public viewing
    // window" pair, which made the reader do the arithmetic.
    expect(await screen.findByText(/Expires in 1h 29m/)).toBeTruthy();
  });

  it("takes the location off screen when the window closes while the tab is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.resolvePublicInvite.mockResolvedValue(invitePayload(5_000));

    render(<PublicLocationViewPageClient />);
    expect(await screen.findByTitle("Live location map")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });

    // The server refuses an expired token, but nobody reloads a map they are
    // already looking at — so without this the link outlives its own expiry
    // for as long as the tab stays open.
    await waitFor(() =>
      expect(screen.queryByTitle("Live location map")).toBeNull(),
    );
    expect(screen.getByText(/Link expired/)).toBeTruthy();
    expect(screen.getByText(/viewing window closed/i)).toBeTruthy();
  });

  it("keeps the pin current instead of freezing where the sender pressed Share", async () => {
    // The page read the link exactly once, on mount, and the snapshot on the
    // row was written exactly once, at create time. So a link sold as a live
    // location showed one point for its whole window.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const moved = invitePayload(60 * 60 * 1000);
    moved.publicLocation = {
      ...moved.publicLocation,
      latitude: 25.1441,
      longitude: 75.8446,
      capturedAt: new Date().toISOString(),
    };
    mocks.resolvePublicInvite
      .mockResolvedValueOnce(invitePayload(60 * 60 * 1000))
      .mockResolvedValue(moved);

    render(<PublicLocationViewPageClient />);
    await act(async () => {
      await Promise.resolve();
    });
    await screen.findByTitle("Live location map");
    expect(mocks.resolvePublicInvite).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });

    expect(mocks.resolvePublicInvite.mock.calls.length).toBeGreaterThan(1);
    expect(
      screen.getByTitle("Live location map").getAttribute("src") || "",
    ).toContain("25.144100");
  });

  it("asks the server before believing a viewer clock that says expired", async () => {
    // The countdown is expiresAt - Date.now(). A device running a few minutes
    // fast would take the map away while the server was still serving the
    // link -- a link created for an hour, gone early, for no reason the person
    // can see. That is the reported symptom, produced entirely on the client.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Opens with a window that is about to close by this browser's clock...
    mocks.resolvePublicInvite.mockResolvedValueOnce(invitePayload(3_000));
    // ...but every later read says there is still half an hour on it.
    mocks.resolvePublicInvite.mockResolvedValue(invitePayload(30 * 60 * 1000));

    render(<PublicLocationViewPageClient />);
    expect(await screen.findByTitle("Live location map")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });

    await waitFor(() =>
      expect(mocks.resolvePublicInvite.mock.calls.length).toBeGreaterThan(1),
    );
    // Still watching, on the server's window rather than this device's.
    expect(screen.getByTitle("Live location map")).toBeTruthy();
    expect(screen.queryByText(/Link expired/)).toBeNull();
  });

  it("takes the location away when the server refuses the link", async () => {
    // Revoked mid-view. The countdown has not run out, but the link is gone.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.resolvePublicInvite.mockResolvedValueOnce(invitePayload(3_000));
    mocks.resolvePublicInvite.mockRejectedValue(
      new Error("This live location link is no longer active."),
    );

    render(<PublicLocationViewPageClient />);
    expect(await screen.findByTitle("Live location map")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });

    await waitFor(() =>
      expect(screen.queryByTitle("Live location map")).toBeNull(),
    );
    expect(screen.getByText(/Link expired/)).toBeTruthy();
  });

  it("states what the link carries, and shows no contact detail", async () => {
    render(<PublicLocationViewPageClient />);

    expect(
      await screen.findByText(/Shared securely through Hussh/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /This link shows a location, who shared it, and when it expires\./i,
      ),
    ).toBeTruthy();

    const body = document.body.textContent || "";
    expect(body).not.toMatch(/does not reveal the sender/i);
    expect(body).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(body).not.toMatch(/\+?\d[\d\s()-]{7,}\d/);
  });
});
