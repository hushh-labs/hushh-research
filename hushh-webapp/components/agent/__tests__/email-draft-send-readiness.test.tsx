import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailDraftCard } from "@/components/agent/email-draft-card";
import { gmailSendGap } from "@/components/agent/email-draft-gmail-readiness";
import { EmailDeliveryService } from "@/lib/services/email-delivery-service";
import { ConnectionsService } from "@/lib/services/connections-service";

type LiveStatus = { connected: boolean; needs_reauth?: boolean; send_permission_granted?: boolean };

const gmail = vi.hoisted(() => ({
  status: null as LiveStatus | null,
  refreshStatus: vi.fn(async () => null),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "synthetic-owner", getIdToken: async () => "synthetic-id-token" }, userId: "synthetic-owner" }),
}));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({ status: gmail.status, refreshStatus: gmail.refreshStatus }),
}));
vi.mock("@/lib/services/email-delivery-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/email-delivery-service")>()),
  EmailDeliveryService: { draft: vi.fn(), prepare: vi.fn(), send: vi.fn(), sendStatus: vi.fn(), saveGmailDraft: vi.fn() },
}));

const getAuth = vi.fn(async () => ({ firebaseIdToken: "firebase-token", vaultOwnerToken: "vault-owner-token" }));
const ready = { connected: true, needs_reauth: false, send_permission_granted: true };

describe("Email draft send readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gmail.status = null;
    vi.spyOn(ConnectionsService, "listConnections").mockResolvedValue([]);
    vi.mocked(EmailDeliveryService.prepare).mockResolvedValue({ actionId: "action-1", expiresAt: null });
    vi.mocked(EmailDeliveryService.send).mockResolvedValue({
      actionId: "action-1", messageId: "message-1", threadId: null, outcomeUnknown: false,
    });
  });

  it.each([
    ["the server's answer before the live status loads", "connect_required", null, false, "connect"],
    ["the live status over a stale server answer", "connect_required", ready, false, null],
    ["a reconnect for a revoked grant", "ready", { connected: true, needs_reauth: true }, false, "connect"],
    ["the send grant a read-only connection lacks", null, { connected: true, send_permission_granted: false }, false, "allow"],
    ["a switched-off send the live status cannot see", "send_disabled", ready, false, "allow"],
    ["the live status once a connect from the card finished", "send_disabled", ready, true, null],
    ["nothing for an unknown answer", "unknown", null, false, null],
  ] as const)("uses %s", (_case, hint, live, connectFinished, gap) => {
    expect(gmailSendGap(hint, live, connectFinished)).toBe(gap);
  });

  it("starts the in-place connect instead of a doomed Send, then sends once Gmail is ready", async () => {
    gmail.status = { connected: false };
    const onEnableGmailSend = vi.fn();
    const onSendStarted = vi.fn(() => "attempt-1");
    const card = (enablingGmailSend: boolean) => (
      <EmailDraftCard initialInstruction="" initialDraft={{ to: "pat@example.com", cc: "", bcc: "", subject: "Plan", body: "Hi" }}
        gmailSend="connect_required" onEnableGmailSend={onEnableGmailSend} enablingGmailSend={enablingGmailSend}
        getAuth={getAuth} onRequireVault={vi.fn()} onDismiss={vi.fn()} onSendStarted={onSendStarted} onSent={vi.fn()} />
    );
    const { rerender } = render(card(false));

    expect(screen.getByTestId("one-email-draft-gmail-readiness")).toHaveTextContent("Connect Gmail to send this.");
    fireEvent.click(screen.getByTestId("one-email-draft-send"));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(onEnableGmailSend).toHaveBeenCalledTimes(2);
    // Negative control: the editor stayed open and nothing reached delivery.
    expect(onSendStarted).not.toHaveBeenCalled();
    expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();

    rerender(card(true));
    expect(screen.getByRole("button", { name: "Waiting for Google…" })).toBeDisabled();
    expect(screen.getByTestId("one-email-draft-send")).toBeDisabled();

    // Google's window closed: the card re-reads the connector and clears the notice.
    gmail.refreshStatus.mockClear();
    gmail.status = ready;
    rerender(card(false));
    expect(gmail.refreshStatus).toHaveBeenCalledWith({ force: true, reconcile: false });
    expect(screen.queryByTestId("one-email-draft-gmail-readiness")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("one-email-draft-send"));
    expect(onSendStarted).toHaveBeenCalledWith(expect.objectContaining({ to: "pat@example.com" }));
    await waitFor(() => expect(EmailDeliveryService.send).toHaveBeenCalledTimes(1));
    expect(onEnableGmailSend).toHaveBeenCalledTimes(2);
  });

  it("keeps the editor open when a recipient is missing or is not an email address", async () => {
    const onSendStarted = vi.fn(() => "attempt-1");
    render(
      <EmailDraftCard initialInstruction="" initialDraft={{ to: "", cc: "", bcc: "", subject: "Plan", body: "Hi" }}
        getAuth={getAuth} onRequireVault={vi.fn()} onDismiss={vi.fn()} onSendStarted={onSendStarted} onSent={vi.fn()} />,
    );
    const send = screen.getByTestId("one-email-draft-send");
    const to = screen.getByTestId("one-email-draft-to");

    fireEvent.click(send);
    expect(screen.getByRole("alert")).toHaveTextContent("Add a recipient before sending.");
    fireEvent.change(to, { target: { value: "Sharu" } });
    fireEvent.click(send);
    expect(screen.getByRole("alert")).toHaveTextContent("Use a full email address in To.");
    // Negative control: neither problem closed the editor or reached delivery.
    expect(onSendStarted).not.toHaveBeenCalled();
    expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();

    // Never stricter than the server: a quoted display name may hold a comma.
    fireEvent.change(to, { target: { value: '"Doe, Jane" <jane@example.com>' } });
    fireEvent.click(send);
    expect(onSendStarted).toHaveBeenCalledWith(expect.objectContaining({ to: '"Doe, Jane" <jane@example.com>' }));
    await waitFor(() => expect(EmailDeliveryService.prepare).toHaveBeenCalledTimes(1));
  });
});
