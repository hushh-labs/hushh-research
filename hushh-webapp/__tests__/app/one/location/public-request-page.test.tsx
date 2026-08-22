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

import PublicLocationRequestPageClient from "@/app/one/location/request/[token]/page-client";

/**
 * Expiry is relative to the run, not a literal date. The fixture used to pin
 * 2026-05-20, which silently became a past timestamp — harmless while nothing
 * compared it to the clock, and an "already expired" link the moment the
 * countdown landed.
 */
function invitePayload(expiresInMs: number) {
  return {
    invite: {
      status: "active",
      durationHours: 1,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      ownerLabel: "A trusted person",
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

describe("PublicLocationRequestPageClient", () => {
  beforeEach(() => {
    mocks.resolvePublicInvite.mockResolvedValue(invitePayload(2 * 60 * 60 * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a public location directly without visitor intake", async () => {
    render(<PublicLocationRequestPageClient />);

    await waitFor(() =>
      expect(mocks.resolvePublicInvite).toHaveBeenCalledWith("public-token"),
    );

    const map = await screen.findByTitle("Public location map");
    fireEvent.click(
      screen.getByRole("button", { name: "Recenter public location map" }),
    );

    expect(screen.getByTitle("Public location map")).not.toBe(map);
    expect(mocks.resolvePublicInvite).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText("Your name")).toBeNull();
    expect(screen.queryByPlaceholderText("Phone number")).toBeNull();
    expect(screen.queryByPlaceholderText("Optional message")).toBeNull();
  });

  it("counts the window down instead of printing a timestamp to subtract", async () => {
    mocks.resolvePublicInvite.mockResolvedValue(invitePayload(90 * 60 * 1000));
    render(<PublicLocationRequestPageClient />);

    // "1h 29m" rather than the old "Expires <date>" + "1h public viewing
    // window" pair, which made the reader do the arithmetic.
    expect(await screen.findByText(/Expires in 1h 29m/)).toBeTruthy();
  });

  it("takes the location off screen when the window closes while the tab is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.resolvePublicInvite.mockResolvedValue(invitePayload(5_000));

    render(<PublicLocationRequestPageClient />);
    expect(await screen.findByTitle("Public location map")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });

    // The server refuses an expired token, but nobody reloads a map they are
    // already looking at — so without this the link outlives its own expiry
    // for as long as the tab stays open.
    await waitFor(() =>
      expect(screen.queryByTitle("Public location map")).toBeNull(),
    );
    expect(screen.getByText(/Link expired/)).toBeTruthy();
    expect(screen.getByText(/viewing window closed/i)).toBeTruthy();
  });

  it("states what the link carries, and shows no identifying detail", async () => {
    render(<PublicLocationRequestPageClient />);

    expect(
      await screen.findByText(/Shared securely through Hussh/),
    ).toBeTruthy();
    expect(
      screen.getByText(/does not reveal the sender's name, phone number, or email/i),
    ).toBeTruthy();

    // The payload contract this page renders carries no identity, so the
    // rendered page must not either.
    const body = document.body.textContent || "";
    expect(body).toContain("A trusted person");
    expect(body).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(body).not.toMatch(/\+?\d[\d\s()-]{7,}\d/);
  });
});
