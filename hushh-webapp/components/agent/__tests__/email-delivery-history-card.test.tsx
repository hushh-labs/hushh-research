import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  EmailDeliveryHistoryCard,
  type EmailDeliveryHistoryItem,
} from "@/components/agent/email-delivery-history-card";

const item: EmailDeliveryHistoryItem = {
  id: "delivery-1",
  instruction: "Write an introduction email to me.",
  draft: {
    to: "person@example.com",
    cc: "",
    bcc: "",
    subject: "Hello",
    body: "Welcome to Gmail Agent.",
  },
  status: "sent",
};

describe("EmailDeliveryHistoryCard", () => {
  it("keeps a sent email collapsed until the owner asks to inspect it", () => {
    render(<EmailDeliveryHistoryCard item={item} />);

    expect(screen.getByText("Mail sent")).toBeInTheDocument();
    expect(screen.queryByText(item.instruction)).not.toBeVisible();

    fireEvent.click(screen.getByText("Mail activity"));

    expect(screen.getByText(item.instruction)).toBeVisible();
    expect(screen.getByText(item.draft.subject)).toBeVisible();
    expect(screen.getByText(item.draft.body)).toBeVisible();
  });

  it("offers an editable retry only for a failed delivery", () => {
    const onRetry = vi.fn();
    render(
      <EmailDeliveryHistoryCard
        item={{ ...item, status: "failed", errorMessage: "Email could not be sent." }}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByText("Mail activity"));
    fireEvent.click(screen.getByRole("button", { name: "Edit and retry" }));

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "delivery-1", status: "failed" }),
    );
  });

  // GMAIL_REAUTH_REQUIRED: a revoked or expired grant used to fall back to "Unlock your vault".
  it.each(["GMAIL_SEND_DISABLED", "GMAIL_REAUTH_REQUIRED"])("requires an explicit click before repairing Gmail (%s)", (errorCode) => {
    const onEnableGmailSend = vi.fn();
    render(
      <EmailDeliveryHistoryCard
        item={{
          ...item,
          status: "failed",
          errorCode,
          errorMessage: "Reconnect Gmail to finish enabling email sending.",
        }}
        onEnableGmailSend={onEnableGmailSend}
      />,
    );

    fireEvent.click(screen.getByText("Mail activity"));
    expect(onEnableGmailSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Mail" }));
    expect(onEnableGmailSend).toHaveBeenCalledTimes(1);
    // The failed item travels with the request so its draft can reopen.
    expect(onEnableGmailSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.id, errorCode }),
    );
  });

  it("offers a first Gmail connection in place when the mailbox was never connected", () => {
    const onEnableGmailSend = vi.fn();
    const failed = { ...item, status: "failed" as const, errorMessage: "Mail could not be sent." };
    const { rerender } = render(
      <EmailDeliveryHistoryCard item={failed} onEnableGmailSend={onEnableGmailSend} onRetry={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Mail activity"));
    // Negative control: an ordinary failure offers only the editable retry.
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).not.toBeInTheDocument();

    rerender(
      <EmailDeliveryHistoryCard
        item={{ ...failed, errorCode: "GMAIL_NOT_CONNECTED" }}
        onEnableGmailSend={onEnableGmailSend}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Reconnect Mail" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(onEnableGmailSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: item.id, errorCode: "GMAIL_NOT_CONNECTED" }),
    );
    expect(screen.getByRole("button", { name: "Edit and retry" })).toBeInTheDocument();
  });

  it("waits in place with a quiet Cancel sign-in while Google's window is open", () => {
    const onEnableGmailSend = vi.fn();
    const onCancel = vi.fn();
    render(
      <EmailDeliveryHistoryCard
        item={{ ...item, status: "failed", errorCode: "GMAIL_SEND_PERMISSION_REQUIRED" }}
        onEnableGmailSend={onEnableGmailSend}
        enablingGmailSend
        onCancelEnableGmailSend={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Mail activity"));
    const waiting = screen.getByRole("button", { name: "Waiting for Google…" });
    expect(waiting).toBeDisabled();
    fireEvent.click(waiting);
    expect(onEnableGmailSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps rich formatting available when the owner expands sent email history", () => {
    render(
      <EmailDeliveryHistoryCard
        item={{ ...item, draft: { ...item.draft, body: "**Welcome**\n\n- Draft\n- Send" } }}
      />,
    );

    fireEvent.click(screen.getByText("Mail activity"));
    expect(screen.getByText("Welcome").tagName).toBe("STRONG");
    expect(screen.getByText("Draft").closest("li")).toBeTruthy();
  });

  it("restores only action status after reload and offers a read-only check", () => {
    const onCheckStatus = vi.fn();
    render(
      <EmailDeliveryHistoryCard
        item={{
          ...item,
          actionId: "action-1",
          status: "outcome_unknown",
          restoredOnly: true,
          instruction: "",
          draft: { to: "", cc: "", bcc: "", subject: "", body: "" },
        }}
        onCheckStatus={onCheckStatus}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Mail activity"));
    expect(screen.getByText(/no draft saved here/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit and retry" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(onCheckStatus).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "action-1", status: "outcome_unknown",
    }));
  });
});
