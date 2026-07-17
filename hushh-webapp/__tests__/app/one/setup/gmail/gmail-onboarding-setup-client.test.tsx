import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

import { GmailOnboardingSetupClient } from "@/app/one/setup/gmail/gmail-onboarding-setup-client";

describe("GmailOnboardingSetupClient", () => {
  it("contains the paused setup route at the hub before Gmail mounts", async () => {
    render(<GmailOnboardingSetupClient />);

    expect(screen.getByRole("status", { name: "Opening setup…" })).toBeTruthy();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one/setup");
    });
  });
});
