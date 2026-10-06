import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MailConnectedAccount,
  MailOverview,
} from "@/components/gmail/mail-overview";

describe("Mail overview", () => {
  it("shows only the envelope for a connected Mail account", () => {
    render(
      <MailConnectedAccount
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(
      screen
        .getByTestId("mail-connected-account-icon")
        .querySelectorAll("svg"),
    ).toHaveLength(1);
  });

  it("removes the fetching indicator when receipts finish and keeps the receipt panel read-only", () => {
    const onOpenChat = vi.fn();
    const props = { receiptUpdated: "Last updated just now.", onOpenChat };
    const { rerender } = render(<MailOverview {...props} fetching receiptDetail="Fetching your latest purchases…" />);
    expect(screen.getByRole("status", { name: "Fetching receipts" })).toBeInTheDocument();
    expect(screen.queryByText("Agent One")).not.toBeInTheDocument();
    rerender(<MailOverview {...props} fetching={false} receiptDetail="Your latest receipts are ready." />);
    expect(screen.queryByRole("status", { name: "Fetching receipts" })).not.toBeInTheDocument();
    expect(screen.getByText("Your latest receipts are ready.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open receipts" })).not.toBeInTheDocument();
    expect(screen.getByTestId("mail-receipt-sync").querySelector("button, a, [data-slot=settings-row-chevron]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat with One" }));
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Chat with One" }).querySelector("svg")).toBeNull();
  });
});
