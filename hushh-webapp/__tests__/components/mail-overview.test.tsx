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

  it("keeps the chat action without rendering the removed receipt sync card", () => {
    const onOpenChat = vi.fn();
    const props = { receiptUpdated: "Last updated just now.", onOpenChat };
    const { rerender } = render(<MailOverview {...props} fetching receiptDetail="Fetching your latest purchases…" />);
    expect(screen.queryByRole("status", { name: "Fetching receipts" })).not.toBeInTheDocument();
    expect(screen.queryByText("Agent One")).not.toBeInTheDocument();
    expect(screen.queryByText("Receipt sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Fetching your latest purchases…")).not.toBeInTheDocument();
    rerender(<MailOverview {...props} fetching={false} receiptDetail="Your latest receipts are ready." />);
    expect(screen.queryByRole("status", { name: "Fetching receipts" })).not.toBeInTheDocument();
    expect(screen.queryByText("Your latest receipts are ready.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open receipts" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mail-receipt-sync")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chat with One" }));
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Chat with One" }).querySelector("svg")).toBeNull();
  });
});
