import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

const source = readFileSync(
  join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
  "utf8",
);

describe("Agent Chat email draft layout contract", () => {
  it("keeps a draft in the conversation scroller, then hands send work to a collapsible history item", () => {
    expect(source).toContain("emailDraftOpen");
    expect(source).toContain("initialInstruction={emailDraftInstruction}");
    expect(source).toContain(
      "emailDraftInstruction = handoff.emailDraftInstruction?.trim()",
    );
    expect(source).toContain("openGmailEmailDraftFromDirective");
    expect(source).toContain('event.raw.toolName !== "open_gmail_email_draft"');
    expect(source).toContain("setEmailDraftAutoDraft(!payload.initialDraft);");
    expect(source).toContain("initialDraft: body");
    expect(source).toContain("getGmailInformationRequestReplyPayload");
    expect(source).toContain('event.raw.toolName !== "open_gmail_information_request_reply"');
    expect(source).toContain(
      '"Reply to the selected Gmail email with appropriate details from my memory."',
    );
    expect(source).not.toContain("appropriate details from my PKM");
    expect(source).toContain("gmailInformationRequestWorkflowId: gmailInformationRequest.workflow_id");
    expect(source).not.toContain("prepareScopedGmailInformationRequestDraft");
    expect(source).toContain("autoDraft={emailDraftAutoDraft}");
    expect(source).toContain("onSendStarted={handleEmailSendStarted}");
    expect(source).toContain("EmailDeliveryHistoryCard");
    expect(source).toContain("bucketEmailDeliveryTimelineItems");
    expect(source).toContain("emailDraftAnchorMessageId");
    expect(source).toContain("setEmailDraftAnchorMessageId(assistantMessageId);");
    expect(source).toContain("message.id === emailDraftAnchorMessageId");
    expect(source).toContain("renderEmailDraftCard()");
    expect(source).toContain("sourceBoundReply=");
    expect(source).toContain("sourceBoundEnvelope={gmailKycEmailDraftEnvelope}");
    expect(source).toContain("source.reply_to?.trim() || source.from.trim()");
    expect(source).not.toContain("sourceBoundContext=");
    expect(source).not.toContain("gmailKycRequestSummary");
    expect(source).toContain("sourceWorkflowId: workflowId");
    expect(source).toContain("const prepared = await EmailDeliveryService.prepare");
    expect(source).not.toContain("GmailInformationRequestsService.prepareReply");
    expect(source).not.toContain("GmailKycReplyCard");
    expect(source).toContain("itemsAfterMessage.get(message.id)");
    expect(source).toContain(
      "openGmailEmailDraftFromDirective(toolEvent, assistantMessageId);",
    );
    expect(source).toContain("kycInformationSaveConfirmed:");
    expect(source).toContain("gmailInformationRequestWorkflowId:");
    expect(source).not.toContain(
      "current.filter((message) => message.id !== assistantMessageId)",
    );
    expect(source).toContain("setQueuedHandoffPrompt(emailDraftInstruction);");
    expect(source).not.toContain('aria-label="Draft an email"');
    expect(source).not.toContain(
      'className="shrink-0 border-t border-border/70 bg-background px-3 pt-3 sm:px-5"',
    );
  });

  it("keeps the composer open while a mail draft waits for review", () => {
    const block = (start: string, end: string) => {
      const from = source.indexOf(start);
      expect(from).toBeGreaterThan(-1);
      return source.slice(from, source.indexOf(end, from));
    };
    // The composer and its textarea stay usable.
    expect(block("const canSend =", ";")).not.toContain("emailDraftOpen");
    expect(block('aria-label={composerExpanded ? "Expanded message One"', "placeholder=")).not.toContain(
      "emailDraftOpen",
    );
    // Voice turns do not carry the draft, so voice still waits on the card.
    expect(block("const canToggleVoice =", ";")).toContain("!emailDraftOpen");
    // The follow-up turn carries the draft as it is on screen, edits included.
    expect(source).toContain("onDraftChange={handleEmailDraftChange}");
    expect(source).toContain("pendingEmailDraft: pendingEmailDraftFrameRef.current");
    expect(source).toContain("emailDraftCardValueRef.current,");
    // A revision is not a confirmed KYC save.
    expect(source).toContain(
      "Boolean(gmailKycReplyRequest?.workflow_id) && !emailDraftOpen",
    );
  });

  it("reserves the expanded editor's full action rail on phones", () => {
    expect(source).toContain("pb-14 pr-32 pt-4");
  });
});

// Execute the authored callbacks: mounting the workspace would require unrelated
// native ports. This checks authority behavior, rather than snapshotting its text.
describe("Mail status owner-session boundary", () => {
  it("fences deferred tokens, ABA owners, duplicate checks and stale completion", async () => {
    const from = source.indexOf("  const getEmailDeliveryAuth =");
    const block = source.slice(from, source.indexOf("\n  useEffect(() => {\n    if (!user?.uid || !isVaultUnlocked || !tokenIsFresh) return;", from));
    const compiled = ts.transpileModule(block + "\nreturn { getEmailDeliveryAuth, checkEmailDeliveryStatus };",
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => { resolve = settle; });
      return { promise, resolve };
    };
    const token = deferred<string>();
    let epoch = 1;
    const emailScopeRef = { current: { ownerId: "owner-a", epoch } };
    const workspaceOwnerIdRef = { current: "owner-a" };
    const emailStatusOperationRef = { current: null };
    const setCheckingEmailActionId = vi.fn();
    const setEmailDeliveryHistory = vi.fn();
    const forgetPendingEmailSendAction = vi.fn();
    const sendStatus = vi.fn();
    const deps = { emailScopeRef, workspaceOwnerIdRef, emailStatusOperationRef,
      isVaultSessionEpochCurrent: (value: number) => value === epoch,
      user: { uid: "owner-a", getIdToken: vi.fn(() => token.promise) },
      isVaultUnlocked: true, tokenIsFresh: true, checkingEmailActionId: null,
      getVaultOwnerToken: () => "synthetic-owner-token", setCheckingEmailActionId,
      setVaultDialogOpen: vi.fn(), setEmailDeliveryHistory, forgetPendingEmailSendAction,
      EmailDeliveryService: { sendStatus } };
    const callbacks = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
    const replaceOwner = (ownerId: string) => {
      workspaceOwnerIdRef.current = ownerId;
      emailScopeRef.current = { ownerId, epoch: ++epoch };
    };
    const oldAuth = callbacks.getEmailDeliveryAuth();
    replaceOwner("owner-b"); replaceOwner("owner-a");
    token.resolve("synthetic-firebase-token");
    expect(await oldAuth).toBeNull();
    const oldResult = deferred<{ state: string }>();
    const nextResult = deferred<{ state: string }>();
    sendStatus.mockReturnValueOnce(oldResult.promise).mockReturnValueOnce(nextResult.promise);
    const oldCheck = callbacks.checkEmailDeliveryStatus({ actionId: "old-action" });
    await Promise.resolve(); await Promise.resolve();
    await callbacks.checkEmailDeliveryStatus({ actionId: "duplicate-action" });
    expect(sendStatus).toHaveBeenCalledTimes(1);
    replaceOwner("owner-b"); replaceOwner("owner-a");
    const newCheck = callbacks.checkEmailDeliveryStatus({ actionId: "new-action" });
    await Promise.resolve(); await Promise.resolve();
    expect(sendStatus).toHaveBeenCalledTimes(2);
    oldResult.resolve({ state: "sent" });
    await oldCheck;
    expect(setEmailDeliveryHistory).not.toHaveBeenCalled();
    expect(forgetPendingEmailSendAction).not.toHaveBeenCalled();
    expect(setCheckingEmailActionId).toHaveBeenLastCalledWith("new-action");
    nextResult.resolve({ state: "sent" });
    await newCheck;
    expect(forgetPendingEmailSendAction).toHaveBeenCalledExactlyOnceWith("owner-a", "new-action");
    expect(setEmailDeliveryHistory).toHaveBeenCalledTimes(1);
    expect(setCheckingEmailActionId).toHaveBeenLastCalledWith(null);
    // A same-owner unlock must release stale checking UI without erasing history.
    const resetStart = source.indexOf("  useEffect(() => {", source.indexOf("const emailHistoryOwnerRef ="));
    const reset = source.slice(resetStart, source.indexOf("  const [activeFrontendToolCount", resetStart));
    expect(reset).toContain("[user?.uid, vaultSessionEpoch]");
    const resetDeps = { user: deps.user, vaultSessionEpoch: ++epoch,
      emailStatusOperationRef, setCheckingEmailActionId,
      emailHistoryOwnerRef: { current: "owner-a" }, emailDeliveryActionByAttemptRef: { current: new Map() },
      setEmailDeliveryHistory, useEffect: (callback: () => void) => callback() };
    setCheckingEmailActionId.mockClear(); setEmailDeliveryHistory.mockClear();
    new Function(...Object.keys(resetDeps), ts.transpileModule(reset, {}).outputText)(...Object.values(resetDeps));
    expect(setCheckingEmailActionId).toHaveBeenCalledExactlyOnceWith(null);
    expect(emailStatusOperationRef.current).toBeNull();
    expect(setEmailDeliveryHistory).not.toHaveBeenCalled();
  });
});
