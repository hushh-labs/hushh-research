import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  start: vi.fn(),
  user: { uid: "owner-1", getIdToken: vi.fn(async () => "firebase-token") },
}));

vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/services/public-profile-discovery-service", () => ({
  PublicProfileDiscoveryService: { getStatus: mocks.getStatus, start: mocks.start },
}));

import { PublicProfileDiscoveryCard } from "@/components/profile/public-profile-discovery-card";

describe("PublicProfileDiscoveryCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStatus.mockResolvedValue(null);
    mocks.start.mockResolvedValue({ job_id: "job-1", status: "queued" });
  });

  it("requires public-web consent and keeps phone matching as a separate opt-in", async () => {
    render(<PublicProfileDiscoveryCard userId="owner-1" />);

    expect(await screen.findByText("Claim your public profile")).toBeInTheDocument();
    expect(screen.getByText(/account deletion do not remove that shared record/)).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start one-time search" });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I agree to a one-time public-web search/));
    expect(start).toBeEnabled();
    fireEvent.click(start);

    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("firebase-token", {
      consent: true,
      consentVersion: "public_profile_discovery_v2",
      externalPhoneConsent: false,
    }));
  });

  it("does not render for a cohort where discovery is disabled", async () => {
    mocks.getStatus.mockRejectedValue(new Error("profile_discovery_unavailable"));
    const { container } = render(<PublicProfileDiscoveryCard userId="owner-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
