import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("@/lib/services/google-email-send-service", () => ({
  GoogleEmailSendService: { prepare: mocks.prepare },
}));

import { EmailDraftCard } from "@/components/agent/email-draft-card";
import { ROUTES } from "@/lib/navigation/routes";

describe("EmailDraftCard", () => {
  it("sends a missing-permission recovery link back to the Email agent", async () => {
    mocks.prepare.mockRejectedValueOnce(new Error("Gmail permission is required."));
    render(
      <EmailDraftCard
        userId="user_123"
        vaultOwnerToken="vault-owner-token"
        initialBody="Please send a short hello."
        onClose={vi.fn()}
        onSent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review & continue" }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Enable Gmail sending" })).toHaveAttribute(
        "href",
        ROUTES.EMAIL,
      ),
    );
  });
});
