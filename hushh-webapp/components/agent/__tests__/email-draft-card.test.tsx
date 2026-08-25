import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailDraftCard } from "@/components/agent/email-draft-card";
import { EmailDeliveryService } from "@/lib/services/email-delivery-service";

vi.mock("@/lib/services/email-delivery-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/email-delivery-service")
  >("@/lib/services/email-delivery-service");
  return {
    ...actual,
    EmailDeliveryService: {
      draft: vi.fn(),
      prepare: vi.fn(),
      send: vi.fn(),
    },
  };
});

const getAuth = vi.fn().mockResolvedValue({
  firebaseIdToken: "firebase-token",
  vaultOwnerToken: "vault-owner-token",
});

describe("EmailDraftCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(EmailDeliveryService.draft).mockReset();
    vi.mocked(EmailDeliveryService.prepare).mockReset();
    vi.mocked(EmailDeliveryService.send).mockReset();
    getAuth.mockResolvedValue({
      firebaseIdToken: "firebase-token",
      vaultOwnerToken: "vault-owner-token",
    });
  });

  it("sends the visible draft from one explicit Send click", async () => {
    vi.mocked(EmailDeliveryService.draft).mockResolvedValue({
      to: "person@example.com",
      cc: "",
      bcc: "",
      subject: "A subject",
      body: "A complete message",
      missingDetails: ["whether to include a deadline"],
    });
    vi.mocked(EmailDeliveryService.prepare).mockResolvedValue({
      actionId: "action-1",
      expiresAt: "2026-08-26T00:00:00Z",
    });
    vi.mocked(EmailDeliveryService.send).mockResolvedValue({
      messageId: "msg-1",
      threadId: null,
      outcomeUnknown: false,
    });
    const onSent = vi.fn();

    render(
      <EmailDraftCard
        initialInstruction="Write a note to Pat"
        autoDraft
        getAuth={getAuth}
        onRequireVault={vi.fn()}
        onDismiss={vi.fn()}
        onSent={onSent}
      />,
    );

    await waitFor(() => expect(EmailDeliveryService.draft).toHaveBeenCalled());
    expect(screen.getByDisplayValue("person@example.com")).toBeInTheDocument();
    expect(
      screen.getByTestId("one-email-draft-missing-details"),
    ).toHaveTextContent("deadline");

    fireEvent.change(screen.getByTestId("one-email-draft-subject"), {
      target: { value: "Changed subject" },
    });
    fireEvent.click(screen.getByTestId("one-email-draft-send"));
    await waitFor(() =>
      expect(EmailDeliveryService.send).toHaveBeenCalledTimes(1),
    );
    expect(EmailDeliveryService.prepare).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("opens the existing vault flow instead of calling delivery while auth is absent", async () => {
    getAuth.mockResolvedValue(null);
    const onRequireVault = vi.fn();
    render(
      <EmailDraftCard
        initialInstruction="Draft this"
        getAuth={getAuth}
        onRequireVault={onRequireVault}
        onDismiss={vi.fn()}
        onSent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("one-email-draft-send"));
    await waitFor(() => expect(onRequireVault).toHaveBeenCalledTimes(1));
    expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();
  });

  it("offers Decline instead of a second drafting action", () => {
    const onDismiss = vi.fn();
    render(
      <EmailDraftCard
        initialInstruction="Draft this"
        getAuth={getAuth}
        onRequireVault={vi.fn()}
        onDismiss={onDismiss}
        onSent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Ask One to draft" }),
    ).not.toBeInTheDocument();
  });

  it("hands the reviewed email to background delivery and closes immediately", async () => {
    vi.mocked(EmailDeliveryService.prepare).mockImplementation(
      () => new Promise<never>(() => {}),
    );

    function ClosingHarness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <EmailDraftCard
          initialInstruction="Draft this"
          getAuth={getAuth}
          onRequireVault={vi.fn()}
          onDismiss={() => setOpen(false)}
          onSendStarted={() => {
            setOpen(false);
            return "attempt-1";
          }}
          onSent={vi.fn()}
        />
      ) : (
        <p>Draft closed</p>
      );
    }

    render(<ClosingHarness />);

    fireEvent.change(screen.getByTestId("one-email-draft-to"), {
      target: { value: "person@example.com" },
    });
    fireEvent.change(screen.getByTestId("one-email-draft-subject"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByTestId("one-email-draft-send"));

    expect(screen.getByText("Draft closed")).toBeInTheDocument();
    await waitFor(() =>
      expect(EmailDeliveryService.prepare).toHaveBeenCalledTimes(1),
    );
  });

  it("drafts automatically only after an explicit Email Agent handoff", async () => {
    vi.mocked(EmailDeliveryService.draft).mockResolvedValue({
      to: "person@example.com",
      cc: "",
      bcc: "",
      subject: "Welcome",
      body: "Hello",
      missingDetails: [],
    });

    render(
      <EmailDraftCard
        initialInstruction="Draft a welcome email"
        autoDraft
        getAuth={getAuth}
        onRequireVault={vi.fn()}
        onDismiss={vi.fn()}
        onSent={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(EmailDeliveryService.draft).toHaveBeenCalledWith({
        firebaseIdToken: "firebase-token",
        vaultOwnerToken: "vault-owner-token",
        instruction: "Draft a welcome email",
      }),
    );
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
  });

  it("does not claim success when Gmail cannot confirm the outcome", async () => {
    vi.mocked(EmailDeliveryService.prepare).mockResolvedValue({
      actionId: "action-unknown",
      expiresAt: "2026-08-26T00:00:00Z",
    });
    vi.mocked(EmailDeliveryService.send).mockResolvedValue({
      messageId: null,
      threadId: null,
      outcomeUnknown: true,
    });
    const onSent = vi.fn();
    const onSendFailed = vi.fn();
    render(
      <EmailDraftCard
        initialInstruction="Draft this"
        getAuth={getAuth}
        onRequireVault={vi.fn()}
        onDismiss={vi.fn()}
        onSent={onSent}
        onSendFailed={onSendFailed}
      />,
    );

    fireEvent.change(screen.getByTestId("one-email-draft-to"), {
      target: { value: "person@example.com" },
    });
    fireEvent.click(screen.getByTestId("one-email-draft-send"));

    await waitFor(() => expect(onSendFailed).toHaveBeenCalledTimes(1));
    expect(onSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EMAIL_ACTION_OUTCOME_UNKNOWN" }),
      null,
    );
    expect(onSent).not.toHaveBeenCalled();
  });
});
