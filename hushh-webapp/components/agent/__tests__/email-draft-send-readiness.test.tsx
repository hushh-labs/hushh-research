import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailDraftCard } from "@/components/agent/email-draft-card";
import { gmailSendGap } from "@/components/agent/email-draft-gmail-readiness";
import type { GmailSendReadiness } from "@/lib/agent/email-draft-tool-result";
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
const draftCard = (gmailSend: GmailSendReadiness | null, enablingGmailSend = false) => (
  <EmailDraftCard initialInstruction="" initialDraft={{ to: "pat@example.com", cc: "", bcc: "", subject: "Plan", body: "Hi" }}
    gmailSend={gmailSend} onEnableGmailSend={vi.fn()} enablingGmailSend={enablingGmailSend}
    getAuth={getAuth} onRequireVault={vi.fn()} onDismiss={vi.fn()} onSent={vi.fn()} />
);
const notice = () => screen.queryByTestId("one-email-draft-gmail-readiness");

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
    ["the server's answer over the status cached at open", "connect_required", ready, true, "connect"],
    ["the live status over a stale server answer", "connect_required", ready, false, null],
    ["a reconnect for a revoked grant", "ready", { connected: true, needs_reauth: true }, false, "reconnect"],
    ["the server's reconnect answer before the live status loads", "reconnect_required", null, false, "reconnect"],
    ["the send grant a read-only connection lacks", null, { connected: true, send_permission_granted: false }, false, "allow"],
    ["a switched-off send the live status cannot see", "send_disabled", ready, false, "allow"],
    ["nothing for an unknown answer", "unknown", null, false, null],
  ] as const)("uses %s", (_case, hint, live, cachedAtOpen, gap) => {
    expect(gmailSendGap(hint, live, cachedAtOpen)).toBe(gap);
  });

  it("keeps the server's switched-off send through a cancelled connect, not a confirmed one", async () => {
    gmail.status = ready;
    const { rerender } = render(draftCard("send_disabled"));
    expect(await screen.findByTestId("one-email-draft-gmail-readiness")).toHaveTextContent("Allow One to send from Gmail.");

    // Negative control: Google's window closed without a grant and the re-read landed,
    // so the host kept the answer the live status cannot check.
    rerender(draftCard("send_disabled", true));
    gmail.status = { ...ready };
    rerender(draftCard("send_disabled"));
    expect(notice()).toHaveTextContent("Allow One to send from Gmail.");

    // A confirmed grant: the host drops the answer and the live status decides.
    rerender(draftCard("send_disabled", true));
    rerender(draftCard(null));
    expect(notice()).not.toBeInTheDocument();
  });

  it("keeps a gap the server just reported over a cached connected status until the re-read lands", async () => {
    gmail.status = ready;
    const { rerender } = render(draftCard("connect_required"));

    // Negative control: the old card trusted the cache and skipped both the notice and the re-read.
    expect(await screen.findByTestId("one-email-draft-gmail-readiness")).toHaveTextContent("Connect Gmail to send this.");
    expect(gmail.refreshStatus).toHaveBeenCalledWith({ force: true, reconcile: false });

    // The re-read lands as a new status that still says connected, so the live status decides.
    gmail.status = { ...ready };
    rerender(draftCard("connect_required"));
    expect(notice()).not.toBeInTheDocument();
  });

  it("asks for a reconnect, not a first connect, when the grant needs re-authorisation", async () => {
    gmail.status = { connected: true, needs_reauth: true };
    render(draftCard("connect_required"));
    expect(await screen.findByRole("button", { name: "Reconnect Gmail" })).toBeEnabled();
    expect(notice()).toHaveTextContent("Reconnect Gmail to send this.");
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
