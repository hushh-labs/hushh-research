import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { publishValidatedAuthSessionPrincipal, snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

const source = readFileSync(
  join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
  "utf8",
);
const transformsSource = readFileSync(
  join(process.cwd(), "components/agent/workspace/agent-message-transforms.ts"),
  "utf8",
);
const bubbleSource = readFileSync(
  join(process.cwd(), "components/agent/workspace/agent-bubble.tsx"),
  "utf8",
);
const workspaceUnitSource = `${source}\n${transformsSource}\n${bubbleSource}`;

// Execute the same workspace callbacks at their service ports. The native
// workspace cannot be mounted here; no authorization logic is copied to this fixture.
function historyCallbacks() {
  publishValidatedAuthSessionPrincipal({ firebaseUid: "history-owner", ownerId: "history-owner", accountGeneration: 0 });
  const from = source.indexOf("  const historyListRequest =");
  const list = source.slice(from >= 0 ? from : source.indexOf("  const loadConversationList ="), source.indexOf("  const handleSelectConversation ="));
  const actions = source.slice(source.indexOf("  const handleRenameConversation ="), source.indexOf("  /**\n   * Reveal one card"));
  const compiled = ts.transpileModule(list + actions + "\nreturn { loadConversationList, handleRenameConversation, handleDeleteConversation };",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const deps = {
    useCallback: <T,>(callback: T) => callback,
    useRef: <T,>(value: T) => ({ current: value }),
    applicationOwnerId: "history-owner", user: { uid: "history-owner" },
    workspaceOwnerIdRef: { current: "history-owner" },
    historyListOwner: { current: null as { auth: NonNullable<ReturnType<typeof snapshotValidatedAuthSessionOwner>>; epoch: number } | null },
    snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent,
    snapshotVaultSessionEpoch, isVaultSessionEpochCurrent,
    getVaultOwnerToken: () => "synthetic-capability",
    vaultKeyRef: { current: "synthetic-key" },
    pkmCaptureReadinessRef: { current: { authLoading: false, sessionVerificationRequired: false, isVaultUnlocked: true } },
    warmAgentChatHistoryCache: vi.fn(), renameAgentChatConversation: vi.fn(), deleteAgentChatConversation: vi.fn(),
    clearAgentChatHistoryCache: vi.fn(),
    setConversations: vi.fn(), setIsLoadingHistory: vi.fn(), setHistoryActionPendingId: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() },
    historyInteractionDisabled: false, conversationId: "selected-chat", conversationIdRef: { current: "selected-chat" },
    currentDraftRef: { current: { input: "Unsent synthetic draft", attachment: { text: "Synthetic attachment" } } },
    chatMemory: { withdrawConversation: vi.fn(async () => undefined) },
    handleHistoryDrawerOpenChange: vi.fn(), handleCreateNewChat: vi.fn(),
  };
  const callbacks = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as {
    loadConversationList: () => Promise<unknown>;
    handleRenameConversation: (id: string, title: string) => Promise<void>;
    handleDeleteConversation: (id: string) => Promise<void>;
  };
  return { callbacks, deps };
}

describe("History caller authority", () => {
  it.each(["current", "owner ABA", "vault change"])("publishes deferred list and rename only for %s", async (transition) => {
    const { callbacks, deps } = historyCallbacks();
    const admittedAuth = snapshotValidatedAuthSessionOwner();
    const admittedEpoch = snapshotVaultSessionEpoch();
    let settleList!: (value: { conversations: { id: string }[] }) => void;
    let settleRename!: (value: { id: string }) => void;
    deps.warmAgentChatHistoryCache.mockReturnValueOnce(new Promise(resolve => { settleList = resolve; }));
    deps.renameAgentChatConversation.mockReturnValueOnce(new Promise(resolve => { settleRename = resolve; }));
    deps.warmAgentChatHistoryCache.mockResolvedValue({ conversations: [] });
    const list = callbacks.loadConversationList();
    const rename = callbacks.handleRenameConversation("selected-chat", "Synthetic title");
    deps.setIsLoadingHistory.mockClear(); deps.setHistoryActionPendingId.mockClear();
    if (transition === "owner ABA") {
      publishValidatedAuthSessionPrincipal({ firebaseUid: "another-owner", ownerId: "another-owner", accountGeneration: 0 }); publishValidatedAuthSessionPrincipal({ firebaseUid: "history-owner", ownerId: "history-owner", accountGeneration: 0 });
    } else if (transition === "vault change") advanceVaultSessionEpoch();
    settleList({ conversations: [{ id: "selected-chat" }] }); settleRename({ id: "selected-chat" });
    await Promise.all([list, rename]);
    if (transition === "current") {
      expect(deps.setConversations).toHaveBeenCalled();
      expect(deps.toast.success).toHaveBeenCalledWith("Agent chat renamed.");
      expect(deps.historyListOwner.current).toEqual({ auth: admittedAuth, epoch: admittedEpoch });
    } else {
      expect(deps.setConversations).not.toHaveBeenCalled();
      expect(deps.toast.success).not.toHaveBeenCalled();
      expect(deps.setIsLoadingHistory).not.toHaveBeenCalled();
      expect(deps.setHistoryActionPendingId).not.toHaveBeenCalled();
      expect(deps.historyListOwner.current).toBeNull();
    }
    publishValidatedAuthSessionPrincipal(null);
  });

  it("preserves text and attachment until deletion commits", async () => {
    const { callbacks, deps } = historyCallbacks();
    const draft = structuredClone(deps.currentDraftRef.current);
    deps.deleteAgentChatConversation.mockRejectedValueOnce(new Error("synthetic refusal"));
    await expect(callbacks.handleDeleteConversation("selected-chat")).rejects.toThrow("CHAT_DELETE_FAILED");
    expect(deps.currentDraftRef.current).toEqual(draft);
    expect(deps.handleCreateNewChat).not.toHaveBeenCalled();
    expect(deps.setConversations).not.toHaveBeenCalled();
    deps.deleteAgentChatConversation.mockResolvedValueOnce(undefined);
    deps.warmAgentChatHistoryCache.mockResolvedValue({ conversations: [] });
    await callbacks.handleDeleteConversation("selected-chat");
    expect(deps.chatMemory.withdrawConversation).toHaveBeenCalledWith("selected-chat");
    expect(deps.handleCreateNewChat).toHaveBeenCalledWith({ triggerMemory: false });
    expect(deps.setConversations).toHaveBeenCalledTimes(1);
    expect(deps.clearAgentChatHistoryCache).toHaveBeenCalledWith("history-owner", { includeDevice: true });
    expect(deps.clearAgentChatHistoryCache.mock.invocationCallOrder[0]).toBeLessThan(deps.warmAgentChatHistoryCache.mock.invocationCallOrder[0]);
    publishValidatedAuthSessionPrincipal(null);
  });
});

describe("Initial history warm return", () => {
  it.each(["current", "watched turn", "selection", "typed turn", "owner ABA", "vault change", "cache invalidation", "refresh failure"])(
    "renders expired memory before network and fences %s", async (transition) => {
      publishValidatedAuthSessionPrincipal({ firebaseUid: "history-owner", ownerId: "history-owner", accountGeneration: 0 });
      const start = source.indexOf('    const loadKey = `${applicationOwnerId}:${vaultOwnerToken.slice(0, 12)}`;');
      const end = source.indexOf("    // History is never on the workspace", start);
      expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
      const compiled = ts.transpileModule(source.slice(start, end) + "\nreturn loadRecentConversation;",
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
      const cached = { conversations: [{ id: "selected-chat" }], latestConversationId: "selected-chat", latestMessages: [{ id: "cached" }], isFresh: false };
      let watched = transition === "watched turn";
      if (watched) cached.isFresh = true;
      let chatEpoch = 1, cacheCurrent = true;
      let settle!: (value: typeof cached) => void, fail!: (reason: Error) => void;
      const deps = {
        applicationOwnerId: "history-owner", user: { uid: "history-owner" }, vaultOwnerToken: "synthetic-token", vaultKeyRef: { current: "synthetic-key" },
        skipInitialHistoryLoadRef: { current: false }, historyLoadKeyRef: { current: null }, historyRestoreEpochRef: { current: 1 },
        chatSessionRef: { current: { value: 1, isCurrent: (value: number) => value === chatEpoch } },
        workspaceOwnerIdRef: { current: "history-owner" }, historyListOwner: { current: null },
        snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent, snapshotVaultSessionEpoch, isVaultSessionEpochCurrent,
        peekAgentChatHistoryCache: () => cached,
        isAgentChatHistorySnapshotCurrent: () => cacheCurrent,
        warmAgentChatHistoryCache: vi.fn(() => new Promise<typeof cached>((resolve, reject) => { settle = resolve; fail = reject; })),
        loadAgentChatConversationHistory: vi.fn(async () => [{ id: "refreshed" }]),
        selectedInAppChat: () => "selected-chat", isAgentTurnWatched: () => watched,
        setIsChatLoading: vi.fn(), responseOutputRef: { current: false }, setHasResponseOutput: vi.fn(), setIsStreaming: vi.fn(), stampNow: () => ({}),
        storedMessagesToAgentMessages: (value: unknown) => value,
        mergePendingConsentMessages: (value: unknown) => value, createGreetingMessage: () => ({ id: "greeting" }),
        setConversations: vi.fn(), setMessages: vi.fn(), updateConversationId: vi.fn(),
        setHistoryReadyForSlot: vi.fn(), setIsLoadingHistory: vi.fn(), setSlotHistoryFailed: vi.fn(),
        restorePendingMcpReviews: vi.fn(async () => undefined),
        isPinnedOneStreamConversation: (item: { title?: string }) =>
          String(item.title ?? "").trim().toLowerCase() === "one",
        pendingMainChatIdRef: { current: null },
        setPendingMainChatId: vi.fn(),
        isOneStreamDraftRef: { current: true },
        setIsOneStreamDraft: vi.fn(),
      };
      const restore = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as () => Promise<void>;
      const pending = restore();
      await vi.waitFor(() => expect(deps.setHistoryReadyForSlot).toHaveBeenCalledWith(true));
      expect(deps.warmAgentChatHistoryCache).toHaveBeenCalledTimes(1);
      expect(deps.setIsLoadingHistory).not.toHaveBeenCalledWith(true);
      expect(deps.setMessages.mock.calls[0][0]([])[0]).toEqual({ id: "cached", restoredFromHistory: true });
      if (watched) {
        expect(deps.setMessages.mock.calls[0][0]([])[1]).toMatchObject({ status: "streaming" });
        watched = false;
      }
      deps.setMessages.mockClear(); deps.setConversations.mockClear(); deps.setSlotHistoryFailed.mockClear();
      if (transition === "selection") chatEpoch++;
      if (transition === "typed turn") deps.historyRestoreEpochRef.current++;
      if (transition === "owner ABA") { publishValidatedAuthSessionPrincipal({ firebaseUid: "other-owner", ownerId: "other-owner", accountGeneration: 0 }); publishValidatedAuthSessionPrincipal({ firebaseUid: "history-owner", ownerId: "history-owner", accountGeneration: 0 }); }
      if (transition === "vault change") advanceVaultSessionEpoch();
      if (transition === "cache invalidation") cacheCurrent = false;
      if (transition === "refresh failure") fail(new Error("synthetic refresh failure"));
      else settle(cached);
      await pending;
      if (transition === "current" || transition === "watched turn") {
        expect(deps.loadAgentChatConversationHistory).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
        expect(deps.setMessages.mock.calls[0][0]([])).toEqual([{ id: "refreshed", restoredFromHistory: true }]);
      } else {
        expect(deps.setMessages).not.toHaveBeenCalled();
      }
      expect(deps.setSlotHistoryFailed).not.toHaveBeenCalled();
      publishValidatedAuthSessionPrincipal(null);
    },
  );
});

describe("Agent Chat email draft layout contract", () => {
  it("keeps a draft in the conversation scroller, then hands send work to a collapsible history item", () => {
    expect(workspaceUnitSource).toContain("emailDraftOpen");
    expect(workspaceUnitSource).toContain("initialInstruction={emailDraftInstruction}");
    expect(workspaceUnitSource).toContain(
      "emailDraftInstruction = handoff.emailDraftInstruction?.trim()",
    );
    expect(workspaceUnitSource).toContain("openGmailEmailDraftFromDirective");
    expect(workspaceUnitSource).toContain('event.raw.toolName !== "open_gmail_email_draft"');
    expect(workspaceUnitSource).toContain("setEmailDraftAutoDraft(!payload.initialDraft?.body);");
    expect(workspaceUnitSource).toContain("getGmailInformationRequestReplyPayload");
    expect(workspaceUnitSource).toContain('event.raw.toolName !== "open_gmail_information_request_reply"');
    expect(workspaceUnitSource).toContain(
      '"Reply to the selected Gmail email with appropriate details from my memory."',
    );
    expect(workspaceUnitSource).not.toContain("appropriate details from my PKM");
    expect(workspaceUnitSource).toContain("gmailInformationRequestWorkflowId: gmailInformationRequest.workflow_id");
    expect(workspaceUnitSource).not.toContain("prepareScopedGmailInformationRequestDraft");
    expect(workspaceUnitSource).toContain("autoDraft={emailDraftAutoDraft}");
    expect(workspaceUnitSource).toContain("onSendStarted={handleEmailSendStarted}");
    expect(workspaceUnitSource).toContain("EmailDeliveryHistoryCard");
    expect(workspaceUnitSource).toContain("bucketEmailDeliveryTimelineItems");
    expect(workspaceUnitSource).toContain("emailDraftAnchorMessageId");
    expect(workspaceUnitSource).toContain("setEmailDraftAnchorMessageId(assistantMessageId);");
    expect(workspaceUnitSource).toContain("message.id === emailDraftAnchorMessageId");
    expect(workspaceUnitSource).toContain("renderEmailDraftCard()");
    expect(workspaceUnitSource).toContain("sourceBoundReply=");
    expect(workspaceUnitSource).toContain("sourceBoundEnvelope={gmailKycEmailDraftEnvelope}");
    expect(workspaceUnitSource).toContain("source.reply_to?.trim() || source.from.trim()");
    expect(workspaceUnitSource).not.toContain("sourceBoundContext=");
    expect(workspaceUnitSource).not.toContain("gmailKycRequestSummary");
    expect(workspaceUnitSource).toContain("sourceWorkflowId: workflowId");
    expect(workspaceUnitSource).toContain("const prepared = await EmailDeliveryService.prepare");
    expect(workspaceUnitSource).not.toContain("GmailInformationRequestsService.prepareReply");
    expect(workspaceUnitSource).not.toContain("GmailKycReplyCard");
    expect(workspaceUnitSource).toContain("itemsAfterMessage.get(message.id)");
    expect(workspaceUnitSource).toContain(
      "openGmailEmailDraftFromDirective(toolEvent, assistantMessageId);",
    );
    expect(workspaceUnitSource).toContain("kycInformationSaveConfirmed:");
    expect(workspaceUnitSource).toContain("gmailInformationRequestWorkflowId:");
    expect(workspaceUnitSource).not.toContain(
      "current.filter((message) => message.id !== assistantMessageId)",
    );
    expect(workspaceUnitSource).toContain("setQueuedHandoffPrompt({ text: emailDraftInstruction });");
    expect(workspaceUnitSource).not.toContain('aria-label="Draft an email"');
    expect(workspaceUnitSource).not.toContain(
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
    // Ordinary follow-ups carry the current draft; meeting turns must not borrow Mail context.
    expect(source).toContain("onDraftChange={handleEmailDraftChange}");
    expect(source).toContain("pendingEmailDraft: !options.calendarMeeting && pendingEmailDraftFrameRef.current");
    expect(source).toContain("emailDraftCardValueRef.current,");
    // A revision is not a confirmed KYC save.
    expect(source).toContain(
      "Boolean(gmailKycReplyRequest?.workflow_id) && !emailDraftOpen",
    );
  });

  it("reserves the expanded editor's full action rail on phones", () => {
    expect(source).toContain("pb-14 pt-4");
    expect(source).toContain('canInterruptAndSend && canSend ? "pr-44 sm:pr-48" : "pr-32 sm:pr-36"');
  });
});

// Execute the authored callbacks: mounting the workspace would require unrelated
// native ports. This checks authority behavior, rather than snapshotting its text.
describe("Mail status owner-session boundary", () => {
  it("fences deferred tokens, ABA owners, duplicate checks and stale completion", async () => {
    const from = source.indexOf("  const getEmailDeliveryAuth =");
    const block = source.slice(from, source.indexOf("\n  useEffect(() => {\n    if (!user || !applicationOwnerId || !isVaultUnlocked || !tokenIsFresh) return;", from));
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
      applicationOwnerId: "owner-a", user: { uid: "owner-a", getIdToken: vi.fn(() => token.promise) },
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
    expect(reset).toContain("[applicationOwnerId, vaultSessionEpoch]");
    const resetDeps = { applicationOwnerId: deps.applicationOwnerId, user: deps.user, vaultSessionEpoch: ++epoch,
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
