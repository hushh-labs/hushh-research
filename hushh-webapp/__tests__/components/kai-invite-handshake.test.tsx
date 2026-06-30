import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KaiInviteHandshake } from "@/components/kai/onboarding/kai-invite-handshake";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: null,
  }),
}));

vi.mock("@/lib/services/ria-service", () => ({
  RiaService: {
    acceptInvite: vi.fn(),
    resolveInvite: vi.fn().mockResolvedValue({
      invite_id: "invite-1",
      invite_token: "invite-token",
      status: "pending",
      scope_template_id: "standard",
      duration_mode: "session",
      ria: {
        display_name: "Hushh Advisors",
        headline: "Personalized planning",
        strategy_summary: null,
        verification_status: "verified",
      },
    }),
  },
}));

describe("KaiInviteHandshake", () => {
  it("covers copy invite button type", async () => {
    render(<KaiInviteHandshake inviteToken="invite-token" />);

    const copyButton = (await screen.findByRole("button", {
      name: "Copy invite link",
    })) as HTMLButtonElement;

    expect(copyButton.type).toBe("button");
  });
});
