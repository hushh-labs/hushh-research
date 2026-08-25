import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import GmailNudgesSection from "@/components/gmail/gmail-nudges-section";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: { listNudges: vi.fn() },
}));

describe("GmailNudgesSection", () => {
  it("stops background retries when the backend is unavailable", async () => {
    vi.mocked(GmailReceiptsService.listNudges).mockRejectedValueOnce(
      new Error("fetch failed"),
    );

    render(
      <GmailNudgesSection
        userId="user-1"
        vaultOwnerToken="vault-owner-token"
        isConnected
        idTokenProvider={async () => "firebase-token"}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByText("Inbox details couldn’t load. Refresh to try again."),
      ).toHaveLength(2),
    );

    expect(GmailReceiptsService.listNudges).toHaveBeenCalledTimes(1);
  });
});
