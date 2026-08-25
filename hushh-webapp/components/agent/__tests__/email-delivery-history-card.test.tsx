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

    expect(screen.getByText("Email sent")).toBeInTheDocument();
    expect(screen.queryByText(item.instruction)).not.toBeVisible();

    fireEvent.click(screen.getByText("Email activity"));

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

    fireEvent.click(screen.getByText("Email activity"));
    fireEvent.click(screen.getByRole("button", { name: "Edit and retry" }));

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "delivery-1", status: "failed" }),
    );
  });
});
