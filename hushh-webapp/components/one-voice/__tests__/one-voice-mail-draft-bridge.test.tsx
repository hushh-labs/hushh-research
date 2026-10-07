import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verbatimEmailHtmlFromText } from "@/components/agent/email-rich-text";
import { OneVoiceMailDraftBridge } from "@/components/one-voice/one-voice-mail-draft-bridge";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import type { MailDraftChange } from "@/lib/one-voice/protocol";
import { ConnectionsService } from "@/lib/services/connections-service";
import {
  EmailDeliveryError,
  EmailDeliveryService,
  type EmailDraft,
  type PreparedEmailSend,
  type SentEmailResult,
} from "@/lib/services/email-delivery-service";

const harness = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "firebase-token") } as { uid: string; getIdToken: () => Promise<string> } | null,
  vaultUnlocked: true,
  vaultToken: "vault-token",
  sendFailure: null as { message: string; code: string | null } | null,
  reviewedBody: null as string | null,
  realCard: false,
  voice: null as { reportMailDelivery: (deliveryRef: string, actionId: string) => void; reportMailDraftChange: (change: MailDraftChange) => boolean } | null,
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: harness.user }) }));
vi.mock("@/components/one-voice/voice-session-provider", () => ({
  useOptionalVoiceSession: () => harness.voice,
}));
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
vi.mock("@/lib/services/email-delivery-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/email-delivery-service")>()),
  EmailDeliveryService: {
    draft: vi.fn(),
    prepare: vi.fn(),
    send: vi.fn(),
    saveGmailDraft: vi.fn(),
  },
}));
vi.mock("@/components/agent/email-draft-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/agent/email-draft-card")>();
  const StubEmailDraftCard = ({
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
  );
  return {
    EmailDraftCard: (props: Parameters<typeof actual.EmailDraftCard>[0]) =>
      harness.realCard
        ? <actual.EmailDraftCard {...props} />
        : <StubEmailDraftCard {...(props as unknown as Parameters<typeof StubEmailDraftCard>[0])} />,
  };
});

const payload = () => ({
  draft: {
    to: "jhumma@example.com",
    to_name: "Jhumma",
    subject: "Demo tomorrow",
    body: "Tomorrow - I'll send the demo.\nThanks!",
  },
});

const SOURCE_MAIL_REF = "rs1.R2htLXNlYWxlZC1yZXBseS0x";
const DELIVERY_REF = "dlv_7Hk2pQ9xLm4Vn8Ws";
const SECOND_DELIVERY_REF = "dlv_Second9xLm4Vn8Ws";
// " - " is what rich-text normalization turns into a list item; dictation must survive it.
const DICTATED_REPLY = "Tomorrow - I'll send the demo.";

const replyPayload = () => ({
  delivery_ref: DELIVERY_REF,
  draft: {
    mode: "reply",
    source_mail_ref: SOURCE_MAIL_REF,
    to: "jhumma@example.com",
    to_name: "Jhumma",
    subject: "Re: Demo tomorrow",
    body: DICTATED_REPLY,
  },
});

/** All a reply sends: the person's body as dictated, and the ref the server derives the rest from. */
const boundReply: EmailDraft = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: DICTATED_REPLY,
  htmlBody: verbatimEmailHtmlFromText(DICTATED_REPLY),
  sourceMailRef: SOURCE_MAIL_REF,
};

const reportMailDelivery = vi.fn<(deliveryRef: string, actionId: string) => void>();
const reportMailDraftChange = vi.fn<(change: MailDraftChange) => boolean>();

const DRAFT_REF = "draft_reference_1234";
function reviewedPayload(revision = 1, operationId?: string) {
  return {
    draft_ref: DRAFT_REF, revision, operation_id: operationId,
    draft: { to: "jhumma@example.com", cc: "", bcc: "", subject: "Demo tomorrow", body: "Tomorrow - I'll send the demo.\nThanks!" },
    prepared: { action_id: `action-${revision}`, state: "prepared", expires_at: new Date(Date.now() + 60_000).toISOString(), sender_token: `sender-${revision}`, sender_label: "owner@example.com" },
    delivery_ref: DELIVERY_REF,
  };
}
function reviewStep(payload: Record<string, unknown> = reviewedPayload(), kind = "review_mail_draft") {
  const report = vi.fn();
  act(() => useVoiceSessionStore.getState().emitClientStep({
    stepId: `step-${crypto.randomUUID()}`, kind, payload, timeoutS: 30,
  }, report));
  return report;
}

function draftSubmissions() {
  return reportMailDraftChange.mock.calls.map(([change]) => change).filter((change) => change.draft);
}

function enableRealCard() {
  harness.realCard = true;
  vi.spyOn(ConnectionsService, "listConnections").mockResolvedValue([]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function openDraft(input: Record<string, unknown> = payload(), stepId = "mail-step-1") {
  const report = vi.fn((status: string) => {
    if (status === "ok") expect(screen.getByTestId("one-email-draft-card")).toBeInTheDocument();
  });
  act(() => {
    useVoiceSessionStore.getState().emitClientStep({
      stepId,
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
  harness.realCard = false;
  reportMailDelivery.mockReset();
  reportMailDraftChange.mockReset().mockReturnValue(true);
  harness.voice = { reportMailDelivery, reportMailDraftChange };
  vi.mocked(EmailDeliveryService.prepare).mockReset();
  vi.mocked(EmailDeliveryService.send).mockReset();
  vi.mocked(EmailDeliveryService.saveGmailDraft).mockReset();
  act(() => useVoiceSessionStore.getState().reset());
});
afterEach(() => cleanup());

describe("OneVoiceMailDraftBridge", () => {
  it("retains an unprepared draft with an enable-sending action and never acknowledges send readiness", async () => {
    enableRealCard();
    render(<OneVoiceMailDraftBridge />);
    const report = reviewStep({ ...reviewedPayload(), prepared: null, reason_code: "GMAIL_SEND_DISABLED" });
    expect(report).toHaveBeenCalledExactlyOnceWith("ok", { mounted: true, draft_ref: DRAFT_REF, revision: 1 });
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue("Demo tomorrow");
    expect(screen.getByRole("link", { name: "Enable sending" })).toHaveAttribute("href", "/one/gmail");
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    await waitFor(() => expect(draftSubmissions()).toHaveLength(1));
    const prepared = reviewedPayload(2, draftSubmissions()[0].operation_id);
    const ready = reviewStep(prepared);
    expect(ready).toHaveBeenCalledExactlyOnceWith("ok", { mounted: true, draft_ref: DRAFT_REF, revision: 2, action_id: "action-2" });
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeEnabled();
    expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
  });

  it("keeps oversized text local and permits a correction without waiting for an invalid frame", async () => {
    enableRealCard();
    render(<OneVoiceMailDraftBridge />);
    reviewStep();
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: "s".repeat(257) } });
    await screen.findByText(/Shorten the draft to continue/);
    expect(draftSubmissions()).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue("s".repeat(257));
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: "Corrected" } });
    await waitFor(() => expect(draftSubmissions()).toHaveLength(1));
    expect(draftSubmissions()[0]).toMatchObject({ revision: 1, draft: { subject: "Corrected" } });
  });

  it("acknowledges the exact mounted review without private fields and sends that prepared action on tap", async () => {
    enableRealCard();
    vi.mocked(EmailDeliveryService.send).mockResolvedValue({ actionId: "action-1", messageId: null, outcomeUnknown: false });
    render(<OneVoiceMailDraftBridge />);
    const report = reviewStep();
    expect(report).toHaveBeenCalledExactlyOnceWith("ok", { mounted: true, draft_ref: DRAFT_REF, revision: 1, action_id: "action-1" });
    expect(screen.getByTestId("one-email-reviewed-sender")).toHaveTextContent("owner@example.com");
    expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(EmailDeliveryService.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actionId: "action-1", senderToken: "sender-1", draftRef: DRAFT_REF, revision: 1,
      draft: { ...reviewedPayload().draft, htmlBody: undefined },
    })));
    expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();
    expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Mail sent.");
  });

  it("invalidates immediately and coalesces newer typing across delayed review responses", async () => {
    enableRealCard();
    render(<OneVoiceMailDraftBridge />);
    reviewStep();
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: "First edit" } });
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    expect(reportMailDraftChange).toHaveBeenLastCalledWith({ draft_ref: DRAFT_REF, revision: 1, operation_id: expect.any(String) });
    await waitFor(() => expect(draftSubmissions()).toHaveLength(1));
    const first = draftSubmissions()[0];
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: "Newest edit" } });
    const stalePayload = reviewedPayload(2, first.operation_id);
    stalePayload.draft.subject = "First edit";
    const staleReport = reviewStep(stalePayload);
    expect(staleReport).toHaveBeenCalledExactlyOnceWith("failed", { reason: "superseded_edit" });
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue("Newest edit");
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    expect(draftSubmissions()).toHaveLength(2);
    const latest = draftSubmissions()[1];
    expect(latest).toMatchObject({ revision: 2, draft: { subject: "Newest edit" } });
    const latestPayload = reviewedPayload(3, latest.operation_id);
    latestPayload.draft.subject = "Newest edit";
    const finalReport = reviewStep(latestPayload);
    expect(finalReport).toHaveBeenCalledExactlyOnceWith("ok", { mounted: true, draft_ref: DRAFT_REF, revision: 3, action_id: "action-3" });
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue("Newest edit");
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeEnabled();
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
  });

  it("keeps invalid input editable and uses the returned revision for the next correction", async () => {
    enableRealCard();
    render(<OneVoiceMailDraftBridge />);
    reviewStep();
    fireEvent.change(screen.getByRole("textbox", { name: "To", exact: true }), { target: { value: "unfinished" } });
    await waitFor(() => expect(draftSubmissions()).toHaveLength(1));
    const first = draftSubmissions()[0];
    const report = vi.fn();
    act(() => useVoiceSessionStore.getState().emitClientStep({ stepId: "invalid-draft-outcome", kind: "mail_draft_outcome",
      payload: { draft_ref: DRAFT_REF, revision: 2, operation_id: first.operation_id, status: "needs_input" }, timeoutS: 30 }, report));
    expect(report).toHaveBeenCalledExactlyOnceWith("ok", { draft_ref: DRAFT_REF, revision: 2 });
    expect(screen.getByRole("textbox", { name: "To", exact: true })).toHaveValue("unfinished");
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "To", exact: true }), { target: { value: "corrected@example.com" } });
    await waitFor(() => expect(draftSubmissions()).toHaveLength(2));
    expect(draftSubmissions()[1]).toMatchObject({ revision: 2, draft: { to: "corrected@example.com" } });
  });

  it("revokes a backgrounded review while showing the exact action's verified uncertain result", () => {
    enableRealCard();
    render(<OneVoiceMailDraftBridge />);
    reviewStep();
    const oldVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(reportMailDraftChange).toHaveBeenLastCalledWith({ draft_ref: DRAFT_REF, revision: 1, operation_id: expect.any(String), closed: true });
      expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
      const report = vi.fn();
      act(() => useVoiceSessionStore.getState().emitClientStep({ stepId: "late-outcome", kind: "mail_draft_outcome", payload: {
        draft_ref: DRAFT_REF, revision: 1, action_id: "action-1", status: "outcome_unknown",
      }, timeoutS: 30 }, report));
      expect(report).toHaveBeenCalledExactlyOnceWith("ok", { draft_ref: DRAFT_REF, revision: 1, action_id: "action-1" });
      expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Check Sent Mail before trying again.");
      expect(EmailDeliveryService.send).not.toHaveBeenCalled();
    } finally {
      if (oldVisibility) Object.defineProperty(document, "visibilityState", oldVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("stops a tapped Send if the surface backgrounds while owner authentication is pending", async () => {
    enableRealCard();
    const token = deferred<string>();
    harness.user!.getIdToken = () => token.promise;
    render(<OneVoiceMailDraftBridge />);
    reviewStep();
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    const oldVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(reportMailDraftChange).toHaveBeenLastCalledWith({ draft_ref: DRAFT_REF, revision: 1, operation_id: expect.any(String), closed: true });
      await act(async () => token.resolve("firebase-token"));
      expect(EmailDeliveryService.send).not.toHaveBeenCalled();
      expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Review this draft again before sending.");
    } finally {
      if (oldVisibility) Object.defineProperty(document, "visibilityState", oldVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("shows a spoken send result only for the exact mounted prepared action", () => {
    enableRealCard();
    render(<OneVoiceMailDraftBridge />);
    reviewStep();
    const outcome = (actionId: string) => {
      const report = vi.fn();
      act(() => useVoiceSessionStore.getState().emitClientStep({ stepId: `outcome-${actionId}`, kind: "mail_draft_outcome", payload: {
        draft_ref: DRAFT_REF, revision: 1, action_id: actionId, status: "sent",
      }, timeoutS: 30 }, report));
      return report;
    };
    expect(outcome("wrong-action")).toHaveBeenCalledWith("failed", { reason: "stale_review" });
    expect(screen.getByTestId("one-email-draft-card")).toBeInTheDocument();
    expect(outcome("action-1")).toHaveBeenCalledWith("ok", { draft_ref: DRAFT_REF, revision: 1, action_id: "action-1" });
    expect(screen.queryByTestId("one-email-draft-card")).toBeNull();
    expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Mail sent.");
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
  });

  it("retains the exact draft for fresh review when newer speech cancels approval before sending", () => {
    enableRealCard();
    render(<OneVoiceMailDraftBridge />);
    reviewStep();
    const report = vi.fn();
    act(() => useVoiceSessionStore.getState().emitClientStep({ stepId: "superseded-approval", kind: "mail_draft_outcome", payload: {
      draft_ref: DRAFT_REF, revision: 1, action_id: "action-1", status: "needs_input", reason_code: "VOICE_APPROVAL_SUPERSEDED",
    }, timeoutS: 30 }, report));
    expect(report).toHaveBeenCalledExactlyOnceWith("ok", { draft_ref: DRAFT_REF, revision: 1, action_id: "action-1" });
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue("Demo tomorrow");
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    expect(screen.getByText("Review the current email again. Nothing was sent.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review again" })).toBeEnabled();
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
  });

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

  it("saves a voice-opened draft to Gmail Drafts through the real card without sending", async () => {
    harness.realCard = true;
    vi.spyOn(ConnectionsService, "listConnections").mockResolvedValue([]);
    vi.mocked(EmailDeliveryService.saveGmailDraft).mockResolvedValue();
    render(<OneVoiceMailDraftBridge />);
    const report = openDraft();
    expect(report).toHaveBeenCalledExactlyOnceWith("ok", { mounted: true });
    expect(screen.getByTestId("one-email-draft-to")).toHaveValue("jhumma@example.com");

    fireEvent.click(screen.getByTestId("one-email-draft-save-gmail"));

    await waitFor(() => expect(screen.getByTestId("one-email-draft-save-gmail")).toHaveTextContent("Saved in Gmail Drafts"));
    expect(EmailDeliveryService.saveGmailDraft).toHaveBeenCalledExactlyOnceWith({
      firebaseIdToken: "firebase-token",
      vaultOwnerToken: "vault-token",
      draft: expect.objectContaining({
        to: "jhumma@example.com",
        subject: "Demo tomorrow",
        body: "Tomorrow - I'll send the demo.\nThanks!",
      }),
    });
    expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
    // Saving keeps the draft open for review; no delivery status appears.
    expect(screen.getByTestId("one-email-draft-card")).toBeInTheDocument();
    expect(screen.queryByTestId("one-voice-mail-delivery")).toBeNull();
  });

  it("sends a voice reply in its original thread from a locked envelope with the dictated body verbatim", async () => {
    harness.realCard = true;
    vi.mocked(EmailDeliveryService.prepare).mockResolvedValue({ actionId: "reply-action-1", expiresAt: null });
    vi.mocked(EmailDeliveryService.send).mockResolvedValue({
      actionId: "reply-action-1", messageId: "reply-message", threadId: "source-thread", outcomeUnknown: false,
    });
    render(<OneVoiceMailDraftBridge />);
    expect(openDraft(replyPayload())).toHaveBeenCalledExactlyOnceWith("ok", { mounted: true });

    // The server-derived envelope is read-only, and a reply has no Gmail Drafts path.
    expect(screen.getByTestId("one-email-draft-source-bound-to")).toHaveValue("jhumma@example.com");
    expect(screen.getByTestId("one-email-draft-source-bound-subject")).toHaveValue("Re: Demo tomorrow");
    expect(screen.queryByTestId("one-email-draft-to")).toBeNull();
    expect(screen.queryByTestId("one-email-draft-subject")).toBeNull();
    expect(screen.queryByTestId("one-email-draft-save-gmail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Reply sent in the original thread."),
    );
    // Recipient, subject and thread are re-derived from the ref on both requests,
    // never taken from the card, and no other source binding rides along.
    expect(EmailDeliveryService.prepare).toHaveBeenCalledExactlyOnceWith({
      firebaseIdToken: "firebase-token",
      vaultOwnerToken: "vault-token",
      idempotencyKey: expect.any(String),
      draft: boundReply,
    });
    expect(EmailDeliveryService.send).toHaveBeenCalledExactlyOnceWith({
      firebaseIdToken: "firebase-token",
      vaultOwnerToken: "vault-token",
      actionId: "reply-action-1",
      draft: boundReply,
    });
    expect(reportMailDelivery).toHaveBeenCalledExactlyOnceWith(DELIVERY_REF, "reply-action-1");
  });

  it("reopens a reply that failed before sending still bound to its original email", async () => {
    harness.realCard = true;
    vi.mocked(EmailDeliveryService.prepare)
      .mockRejectedValueOnce(new EmailDeliveryError(
        "Mail couldn't check the original email just now. Nothing was sent. Try again.",
        503,
        "REPLY_SOURCE_RETRYABLE",
      ))
      .mockResolvedValueOnce({ actionId: "reply-action-2", expiresAt: null });
    vi.mocked(EmailDeliveryService.send).mockResolvedValue({
      actionId: "reply-action-2", messageId: "reply-message", threadId: "source-thread", outcomeUnknown: false,
    });
    render(<OneVoiceMailDraftBridge />);
    openDraft(replyPayload());

    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    // Nothing was sent, so the failure is reviewable instead of "check Sent Mail",
    // and there is no send action to report.
    fireEvent.click(await screen.findByRole("button", { name: "Review draft" }));
    expect(EmailDeliveryService.send).not.toHaveBeenCalled();
    expect(reportMailDelivery).not.toHaveBeenCalled();

    expect(screen.getByTestId("one-email-draft-source-bound-to")).toHaveValue("jhumma@example.com");
    expect(screen.getByTestId("one-email-draft-source-bound-subject")).toHaveValue("Re: Demo tomorrow");
    expect(screen.queryByTestId("one-email-draft-to")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Reply sent in the original thread."),
    );
    expect(EmailDeliveryService.prepare).toHaveBeenCalledTimes(2);
    expect(EmailDeliveryService.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ draft: boundReply }));
    expect(EmailDeliveryService.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ actionId: "reply-action-2", draft: boundReply }),
    );
    expect(reportMailDelivery).toHaveBeenCalledExactlyOnceWith(DELIVERY_REF, "reply-action-2");
  });

  it.each([
    // The send route re-read the original and refused: nothing was sent, the
    // card says why, and One stays quiet instead of "I couldn't confirm".
    { code: "REPLY_SOURCE_CHANGED", status: 409, reported: false },
    // Gmail itself rejected it after the request: One says it was not sent.
    { code: "GMAIL_SEND_FAILED", status: 502, reported: true },
  ])("tells One about a reply Send refused with $code only if it reached Gmail", async ({ code, status, reported }) => {
    harness.realCard = true;
    vi.mocked(EmailDeliveryService.prepare).mockResolvedValue({ actionId: "reply-action-1", expiresAt: null });
    vi.mocked(EmailDeliveryService.send).mockRejectedValue(new EmailDeliveryError("Refused.", status, code));
    render(<OneVoiceMailDraftBridge />);
    openDraft(replyPayload());

    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Refused."));
    if (reported) {
      expect(reportMailDelivery).toHaveBeenCalledExactlyOnceWith(DELIVERY_REF, "reply-action-1");
    } else {
      expect(reportMailDelivery).not.toHaveBeenCalled();
    }
  });

  it("reports a compose Send with the action its prepare named, even when delivery is unconfirmed", async () => {
    enableRealCard();
    vi.mocked(EmailDeliveryService.prepare).mockResolvedValue({ actionId: "compose-action-1", expiresAt: null });
    vi.mocked(EmailDeliveryService.send).mockRejectedValue(new TypeError("network response lost"));
    render(<OneVoiceMailDraftBridge />);
    openDraft({ ...payload(), delivery_ref: DELIVERY_REF });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Check Sent Mail before trying again"),
    );
    // No send response arrived; the relay re-reads the action the card prepared.
    expect(reportMailDelivery).toHaveBeenCalledExactlyOnceWith(DELIVERY_REF, "compose-action-1");
  });

  it("sends an old-shape compose step unchanged and never reports a Send without a delivery ref", async () => {
    enableRealCard();
    vi.mocked(EmailDeliveryService.prepare).mockResolvedValue({ actionId: "compose-action-2", expiresAt: null });
    vi.mocked(EmailDeliveryService.send).mockResolvedValue({
      actionId: "compose-action-2", messageId: "compose-message", threadId: null, outcomeUnknown: false,
    });
    render(<OneVoiceMailDraftBridge />);
    openDraft();
    expect(screen.getByTestId("one-email-draft-to")).toHaveValue("jhumma@example.com");
    expect(screen.queryByTestId("one-email-draft-source-bound-to")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Mail sent."));
    const composed: EmailDraft = {
      to: "jhumma@example.com",
      cc: "",
      bcc: "",
      subject: "Demo tomorrow",
      body: payload().draft.body,
      htmlBody: verbatimEmailHtmlFromText(payload().draft.body),
    };
    expect(EmailDeliveryService.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ draft: composed }));
    expect(EmailDeliveryService.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ actionId: "compose-action-2", draft: composed }),
    );
    expect(reportMailDelivery).not.toHaveBeenCalled();
  });

  it("reports a later Send with its own action when an earlier reply finishes preparing during it", async () => {
    enableRealCard();
    const replyPrepare = deferred<PreparedEmailSend>();
    const composeSend = deferred<SentEmailResult>();
    vi.mocked(EmailDeliveryService.prepare)
      .mockReturnValueOnce(replyPrepare.promise)
      .mockResolvedValueOnce({ actionId: "compose-action-2", expiresAt: null });
    vi.mocked(EmailDeliveryService.send)
      .mockReturnValueOnce(composeSend.promise)
      .mockResolvedValueOnce({
        actionId: "reply-action-1", messageId: "reply-message", threadId: "source-thread", outcomeUnknown: false,
      });
    render(<OneVoiceMailDraftBridge />);
    openDraft(replyPayload());
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(EmailDeliveryService.prepare).toHaveBeenCalledTimes(1));

    // A second voice draft opens and is sent while the reply is still preparing.
    openDraft({ ...payload(), delivery_ref: SECOND_DELIVERY_REF }, "mail-step-2");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(EmailDeliveryService.send).toHaveBeenCalledTimes(1));
    await act(async () => replyPrepare.resolve({ actionId: "reply-action-1", expiresAt: null }));
    await waitFor(() => expect(EmailDeliveryService.send).toHaveBeenCalledTimes(2));
    await act(async () => composeSend.resolve({
      actionId: "compose-action-2", messageId: "compose-message", threadId: null, outcomeUnknown: false,
    }));
    await waitFor(() => expect(screen.getByTestId("one-voice-mail-delivery")).toHaveTextContent("Mail sent."));

    // One must hear about the compose Send's own action, never the reply's.
    expect(reportMailDelivery).toHaveBeenCalledWith(SECOND_DELIVERY_REF, "compose-action-2");
    expect(reportMailDelivery).not.toHaveBeenCalledWith(SECOND_DELIVERY_REF, "reply-action-1");
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
