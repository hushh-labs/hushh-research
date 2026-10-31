import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GmailInformationRequestAttachment } from "@/components/agent/agent-chat-workspace";

describe("GmailInformationRequestAttachment", () => {
  it("does not render source email until the owner explicitly opens Mail, then clears it on collapse", async () => {
    const loadPreview = vi.fn().mockResolvedValue({
      from: "sender@example.test",
      subject: "Information request",
      body: "Requested details",
    });

    render(<GmailInformationRequestAttachment loadPreview={loadPreview} />);

    expect(screen.getByRole("button", { name: /^Mail/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("Selected Gmail message")).toBeVisible();
    expect(screen.queryByText("Requested details")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Mail/ }));

    await screen.findByText("Requested details");
    expect(loadPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/sender@example\.test/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Mail/ }));

    await waitFor(() => {
      expect(screen.queryByText("Requested details")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^Mail/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("discards a preview that resolves after Mail is collapsed", async () => {
    let resolvePreview: ((preview: {
      from: string;
      subject: string;
      body: string;
    }) => void) | undefined;
    const loadPreview = vi.fn(
      () =>
        new Promise<{ from: string; subject: string; body: string }>((resolve) => {
          resolvePreview = resolve;
        }),
    );

    render(<GmailInformationRequestAttachment loadPreview={loadPreview} />);
    fireEvent.click(screen.getByRole("button", { name: /^Mail/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Mail/ }));

    await act(async () => {
      resolvePreview?.({
        from: "sender@example.test",
        subject: "Information request",
        body: "Late response",
      });
    });

    expect(screen.queryByText("Late response")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Mail/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
