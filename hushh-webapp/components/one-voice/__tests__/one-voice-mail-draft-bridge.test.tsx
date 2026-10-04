import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OneVoiceMailDraftBridge } from "@/components/one-voice/one-voice-mail-draft-bridge";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import type { EmailDraft } from "@/lib/services/email-delivery-service";

const harness = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "firebase-token") } as { uid: string; getIdToken: () => Promise<string> } | null,
  vaultUnlocked: true,
  vaultToken: "vault-token",
  sendFailure: null as { message: string; code: string | null } | null,
  reviewedBody: null as string | null,
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: harness.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: harness.vaultUnlocked,
    tokenExpiresAt: Date.now() + 60_000,
    getVaultOwnerToken: () => harness.vaultToken,
  }),
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open }: { open: boolean }) => open ? <div data-testid="mail-vault-dialog" /> : null,
}));
vi.mock("@/components/agent/email-draft-card", () => ({
  EmailDraftCard: ({
    initialDraft,
    verbatimInitialBody,
    getAuth,
    onRequireVault,
    onDismiss,
    onSendStarted,
    onSent,
    onSendFailed,
  }: {
    initialDraft: EmailDraft;
    verbatimInitialBody?: boolean;
    getAuth: () => Promise<unknown>;
    onRequireVault: () => void;
    onDismiss: () => void;
    onSendStarted: (draft: EmailDraft) => string;
    onSent: (id: string) => void;
    onSendFailed: (error: { message: string; code: string | null }, id: string) => void;
  }) => (
    <section data-testid="one-email-draft-card" data-verbatim={verbatimInitialBody || undefined}>
      <span data-testid="mail-to">{initialDraft.to}</span>
      <span data-testid="mail-subject">{initialDraft.subject}</span>
      <span data-testid="mail-body">{initialDraft.body}</span>
      <button type="button" onClick={onDismiss}>Decline</button>
      <button type="button" onClick={() => {
        void getAuth().then((auth) => { if (!auth) onRequireVault(); });
      }}>Check auth</button>
      <button type="button" onClick={() => {
        const id = onSendStarted(harness.reviewedBody === null ? initialDraft : { ...initialDraft, body: harness.reviewedBody });
        if (harness.sendFailure) onSendFailed(harness.sendFailure, id);
        else onSent(id);
      }}>Send</button>
    </section>
  ),
}));

const payload = () => ({
  draft: {
    to: "jhumma@example.com",
    to_name: "Jhumma",
    subject: "Demo tomorrow",
    body: "Tomorrow - I'll send the demo.\nThanks!",
  },
});

function openDraft(input: Record<string, unknown> = payload()) {
  const report = vi.fn((status: string) => {
    if (status === "ok") expect(screen.getByTestId("one-email-draft-card")).toBeInTheDocument();
  });
  act(() => {
    useVoiceSessionStore.getState().emitClientStep({
      stepId: "mail-step-1",
      kind: "open_mail_draft",
      payload: input,
      timeoutS: 30,
    }, report);
  });
  return report;
}

beforeEach(() => {
  harness.user = { uid: "owner", getIdToken: vi.fn(async () => "firebase-token") };
  harness.vaultUnlocked = true;
  harness.vaultToken = "vault-token";
  harness.sendFailure = null;
  harness.reviewedBody = null;
  act(() => useVoiceSessionStore.getState().reset());
});
afterEach(() => cleanup());

describe("OneVoiceMailDraftBridge", () => {
  it("acknowledges only after a card mounts in a body portal, outside hidden bottom chrome", () => {
    render(<div data-app-bottom-shell style={{ visibility: "hidden" }}><OneVoiceMailDraftBridge /></div>);
    const report = openDraft();
    expect(report).toHaveBeenCalledExactlyOnceWith("ok", { mounted: true });
    expect(screen.getByTestId("one-voice-mail-portal").parentElement).toBe(document.body);
    expect(screen.getByTestId("mail-to")).toHaveTextContent("jhumma@example.com");
    expect(screen.getByTestId("mail-body")).toHaveTextContent("Tomorrow - I'll send the demo.");
    expect(screen.getByTestId("one-email-draft-card")).toHaveAttribute("data-verbatim", "true");
  });

  it("fits the portal to the visible viewport when a keyboard reduces its height", () => {
    const previous = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const visualViewport = Object.assign(new EventTarget(), {
      offsetTop: 50,
      offsetLeft: 0,
      width: 360,
      height: 500,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
    try {
      render(<OneVoiceMailDraftBridge />);
      openDraft();
      const portal = screen.getByTestId("one-voice-mail-portal");
      expect(portal.style.top).toBe("50px");
      expect(portal.style.height).toBe("500px");
      visualViewport.height = 260;
      act(() => visualViewport.dispatchEvent(new Event("resize")));
      expect(portal.style.height).toBe("260px");
    } finally {
      if (previous) Object.defineProperty(window, "visualViewport", previous);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("rejects malformed input and never mounts or sends a card", () => {
    render(<OneVoiceMailDraftBridge />);
    const report = openDraft({ draft: { ...payload().draft, to: "made-up-address" } });
    expect(report).toHaveBeenCalledExactlyOnceWith("failed", { reason: "invalid_mail_draft" });
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
    expect(screen.queryByTestId("one-voice-mail-delivery")).toBeNull();
  });

  it("keeps the draft through dock removal and lets Decline close without sending", () => {
    const { rerender } = render(<><OneVoiceMailDraftBridge /><div data-testid="voice-dock" /></>);
    openDraft();
    rerender(<><OneVoiceMailDraftBridge /></>);
    expect(screen.queryByTestId("voice-dock")).toBeNull();
    expect(screen.getByTestId("one-email-draft-card")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
    expect(screen.queryByTestId("one-voice-mail-delivery")).toBeNull();
  });

  it("shows sent status only after the card Send tap", () => {
    render(<OneVoiceMailDraftBridge />);
    openDraft();
    expect(screen.queryByTestId("one-voice-mail-delivery")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
    expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Mail sent.");
  });

  it("keeps a failed send and exact reviewed draft available for retry", () => {
    harness.sendFailure = { message: "Gmail send failed.", code: "GMAIL_SEND_DISABLED" };
    render(<OneVoiceMailDraftBridge />);
    openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Gmail send failed.");
    fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
    expect(screen.getByTestId("mail-body").textContent).toBe("Tomorrow - I'll send the demo.\nThanks!");
    expect(screen.queryByTestId("one-voice-mail-delivery")).toBeNull();
    expect(screen.getByTestId("one-email-draft-card")).toHaveAttribute("data-verbatim", "true");
  });

  it("retains a rich-text edit as rich text when reopening a safely failed draft", () => {
    harness.sendFailure = { message: "Rejected before send.", code: "GMAIL_SEND_DISABLED" };
    harness.reviewedBody = "<p>Edited <strong>message</strong></p>";
    render(<OneVoiceMailDraftBridge />);
    openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
    expect(screen.getByTestId("mail-body")).toHaveTextContent("<p>Edited <strong>message</strong></p>");
    expect(screen.getByTestId("one-email-draft-card")).not.toHaveAttribute("data-verbatim");
  });

  it("does not offer a new send after delivery becomes uncertain", () => {
    harness.sendFailure = { message: "Response lost.", code: "EMAIL_ACTION_OUTCOME_UNKNOWN" };
    render(<OneVoiceMailDraftBridge />);
    openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Check Sent Mail before trying again");
    expect(screen.queryByRole("button", { name: "Review draft" })).toBeNull();
  });

  it("rejects an initially locked step promptly and opens the unlock prompt without retaining the draft", () => {
    harness.vaultUnlocked = false;
    render(<OneVoiceMailDraftBridge />);
    const report = openDraft();
    expect(report).toHaveBeenCalledExactlyOnceWith("failed", { reason: "vault_locked" });
    expect(screen.getByTestId("mail-vault-dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
  });

  it("hides and clears an open draft when the owner locks the vault", () => {
    const view = render(<OneVoiceMailDraftBridge />);
    openDraft();
    harness.vaultUnlocked = false;
    view.rerender(<OneVoiceMailDraftBridge />);
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
    harness.vaultUnlocked = true;
    view.rerender(<OneVoiceMailDraftBridge />);
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
  });

  it("never renders a previous owner's draft after identity switches", () => {
    const view = render(<OneVoiceMailDraftBridge />);
    openDraft();
    harness.user = { uid: "other-owner", getIdToken: vi.fn(async () => "other-token") };
    view.rerender(<OneVoiceMailDraftBridge />);
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
    harness.user = { uid: "owner", getIdToken: vi.fn(async () => "firebase-token") };
    view.rerender(<OneVoiceMailDraftBridge />);
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
  });
});
