import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("PublicLocationRequestPageClient", () => {
  beforeEach(() => {
    mocks.resolvePublicInvite.mockResolvedValue({
      invite: {
        status: "active",
        durationHours: 1,
        expiresAt: "2026-05-20T08:30:00.000Z",
        ownerLabel: "A trusted person",
        locationAvailable: true,
      },
      publicLocation: {
        latitude: 28.6139,
        longitude: 77.209,
        accuracyM: 18,
        capturedAt: "2026-05-20T07:30:00.000Z",
        sourcePlatform: "web",
      },
    });
  });

  it("opens a public location directly without visitor intake", async () => {
    render(<PublicLocationRequestPageClient />);

    await waitFor(() =>
      expect(mocks.resolvePublicInvite).toHaveBeenCalledWith("public-token"),
    );

    expect(await screen.findByTitle("Public location map")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Your name")).toBeNull();
    expect(screen.queryByPlaceholderText("Phone number")).toBeNull();
    expect(screen.queryByPlaceholderText("Optional message")).toBeNull();
  });
});
