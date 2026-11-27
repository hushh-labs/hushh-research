/**
 * The real Chat workspace consuming a draft that Mail's Overview opened.
 *
 * Opening, editing, declining and leaving a Mail draft must send nothing, save
 * no Gmail draft, run no model turn and write nothing to Memory; the reply must
 * keep the exact original email and its recipient; and ordinary Chat, with no
 * Mail handoff, must show none of it. The card, the reply bindings and the
 * renewal are covered one by one elsewhere; this is the whole workspace.
 */
import { fixture, resetCalendarChatFixture } from "./calendar-chat-workspace-fixture";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { AgentDockProvider, AgentDockVoiceBoundary } from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { useOneConversationSession, type MailComposeHandoff } from "@/lib/agent/one-conversation-session";
import { ApiService } from "@/lib/services/api-service";
import { EmailDeliveryService } from "@/lib/services/email-delivery-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const SOURCE_REF = `rs1.${"a".repeat(32)}`;
const SOURCE_ID = `ms1.${"b".repeat(32)}`;

beforeEach(() => {
  resetCalendarChatFixture();
  vi.spyOn(EmailDeliveryService, "prepare").mockRejectedValue(new Error("a Mail draft must not prepare a send"));
  vi.spyOn(EmailDeliveryService, "send").mockRejectedValue(new Error("a Mail draft must not send"));
  vi.spyOn(EmailDeliveryService, "saveGmailDraft").mockRejectedValue(new Error("a Mail draft must not be saved to Gmail"));
  vi.spyOn(EmailDeliveryService, "draft").mockRejectedValue(new Error("a Mail draft must not ask the model to write"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  publishValidatedAuthSessionPrincipal(null);
});

function workspace() {
  return render(
    <AgentDockProvider>
      <AgentDockVoiceBoundary>
        <AgentBarSurface />
      </AgentDockVoiceBoundary>
      <AgentChatWorkspace />
    </AgentDockProvider>,
  );
}

function openFromMail(compose: Partial<MailComposeHandoff> & Pick<MailComposeHandoff, "intent">) {
  useOneConversationSession.getState().createHandoff({
    reason: "user_requested",
    mailCompose: {
      ownerId: "owner",
      accountKey: "google-sub-1",
      accountEmail: "owner@example.com",
      expectedAccount: "google-sub-1",
      ...compose,
    },
  });
}

const reply = {
  intent: "reply" as const,
  reply: {
    to: "maya@example.com",
    subject: "Re: Signed document",
    sourceMailRef: SOURCE_REF,
    recipientLabel: "Maya",
    sourceId: SOURCE_ID,
    expiresInSeconds: 900,
    issuedAtMs: Date.now(),
    body: "Could you send the signed document when you can?",
  },
};

function expectNothingSentSavedOrRemembered() {
  expect(EmailDeliveryService.prepare).not.toHaveBeenCalled();
  expect(EmailDeliveryService.send).not.toHaveBeenCalled();
  expect(EmailDeliveryService.saveGmailDraft).not.toHaveBeenCalled();
  expect(EmailDeliveryService.draft).not.toHaveBeenCalled();
  // No model turn ran, and nothing was written to Memory. The workspace's own one-time KYC
  // connector setup is the only write it makes on mounting, with or without Mail; nothing else is.
  expect(ApiService.agentChatRequest).not.toHaveBeenCalled();
  const memoryWrites = vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls
    .map(([write]) => write.domain)
    .filter((domain) => domain !== "kyc_connector");
  expect(memoryWrites).toEqual([]);
}

describe("a Mail draft opened in the real Chat workspace", { timeout: 30000 }, () => {
  it("opens on the exact original, can be edited and declined, and sends, saves and remembers nothing", async () => {
    openFromMail(reply);
    workspace();

    // The reviewed card, on that very email: recipient and subject come from it, read-only.
    const editor = await screen.findByTestId("one-email-draft-message");
    expect(editor).toHaveTextContent("Could you send the signed document when you can?");
    expect(screen.getByTestId("one-email-draft-source-bound-to")).toHaveValue("maya@example.com");
    expect(screen.getByTestId("one-email-draft-source-bound-subject")).toHaveValue("Re: Signed document");
    expect(screen.getByRole("button", { name: "Back to Mail" })).toBeVisible();
    // The handoff was consumed once: nothing opens it a second time.
    expect(useOneConversationSession.getState().pendingHandoff).toBeNull();

    // Editing is the person's own text, kept in the card and nowhere else.
    editor.innerHTML = "<p>Thanks Maya, I will send it today.</p>";
    fireEvent.input(editor);
    expect(screen.getByTestId("one-email-draft-message")).toHaveTextContent("Thanks Maya, I will send it today.");
    expect(screen.getByTestId("one-email-draft-source-bound-to")).toHaveValue("maya@example.com");

    // Declining closes it and the Mail way back goes with it.
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(screen.queryByTestId("one-email-draft-message")).toBeNull());
    expect(screen.queryByRole("button", { name: "Back to Mail" })).toBeNull();
    expectNothingSentSavedOrRemembered();
  });

  it("opens an empty card for Compose and goes straight back to Mail when nothing was written", async () => {
    openFromMail({ intent: "compose" });
    workspace();

    // The card opens with nothing written, so there is nothing to lose and no question to ask.
    expect(await screen.findByTestId("one-email-draft-message")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to Mail" }));
    expect(fixture.router.push).toHaveBeenCalledWith("/one/gmail");
    expect(screen.queryByText("Leave this reply?")).toBeNull();
    expectNothingSentSavedOrRemembered();
  });

  it("goes straight back to Mail from a reply whose starting text was not changed", async () => {
    openFromMail(reply);
    workspace();

    expect(await screen.findByTestId("one-email-draft-message")).toHaveTextContent("Could you send the signed document when you can?");
    fireEvent.click(screen.getByRole("button", { name: "Back to Mail" }));
    expect(fixture.router.push).toHaveBeenCalledWith("/one/gmail");
    expect(screen.queryByText("Leave this reply?")).toBeNull();
    expectNothingSentSavedOrRemembered();
  });

  it("asks before leaving words that were written, keeps them on Keep writing, and leaves to Mail on Leave", async () => {
    openFromMail(reply);
    workspace();

    const editor = await screen.findByTestId("one-email-draft-message");
    editor.innerHTML = "<p>Thanks Maya, I will send it today.</p>";
    fireEvent.input(editor);

    fireEvent.click(screen.getByRole("button", { name: "Back to Mail" }));
    expect(await screen.findByText("Leave this reply?")).toBeVisible();
    expect(fixture.router.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep writing" }));
    await waitFor(() => expect(screen.queryByText("Leave this reply?")).toBeNull());
    expect(screen.getByTestId("one-email-draft-message")).toHaveTextContent("Thanks Maya, I will send it today.");
    expect(screen.getByTestId("one-email-draft-source-bound-to")).toHaveValue("maya@example.com");
    expect(fixture.router.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to Mail" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave" }));
    expect(fixture.router.push).toHaveBeenCalledWith("/one/gmail");
    expectNothingSentSavedOrRemembered();
  });

  it("never opens a draft that was made for another owner", async () => {
    openFromMail({ ...reply, ownerId: "someone-else" });
    workspace();

    await waitFor(() => expect(useOneConversationSession.getState().pendingHandoff).toBeNull());
    expect(screen.queryByTestId("one-email-draft-message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to Mail" })).toBeNull();
    expectNothingSentSavedOrRemembered();
  });

  it("drops a reply whose source is malformed instead of turning it into a new message", async () => {
    openFromMail({ intent: "reply", reply: { ...reply.reply, sourceMailRef: "not-a-reply-reference" } });
    workspace();

    await waitFor(() => expect(useOneConversationSession.getState().pendingHandoff).toBeNull());
    expect(screen.queryByTestId("one-email-draft-message")).toBeNull();
    expectNothingSentSavedOrRemembered();
  });
});

describe("ordinary Chat with no Mail handoff", { timeout: 30000 }, () => {
  it("shows no Mail draft and no way back to Mail", async () => {
    workspace();

    expect(await screen.findByRole("textbox", { name: "Message One" })).toBeVisible();
    expect(screen.queryByTestId("one-email-draft-message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to Mail" })).toBeNull();
    expect(fixture.router.push).not.toHaveBeenCalled();
    expectNothingSentSavedOrRemembered();
  });
});
