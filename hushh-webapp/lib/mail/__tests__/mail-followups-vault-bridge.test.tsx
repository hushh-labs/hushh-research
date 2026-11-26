import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MailFollowupsVaultBridge } from "@/lib/mail/mail-followups-vault-bridge";
import { dispatchLocalPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  vault: vi.fn(),
  load: vi.fn(),
  update: vi.fn(),
  routing: vi.fn(),
  grants: vi.fn(),
  account: vi.fn(),
  check: vi.fn(),
  schedulerStatus: vi.fn(),
  schedulerControl: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mocks.vault }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatusForRouting: mocks.routing },
}));
vi.mock("@/lib/services/todo-list-pkm-service", () => ({
  TODO_LIST_PKM_DOMAIN: "one_todos",
  TodoListPkmService: { load: mocks.load, updateMail: mocks.update },
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData: vi.fn() },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));
vi.mock("@/lib/services/private-google-connections", () => ({
  privateMailAccounts: mocks.grants,
  PRIVATE_MAIL_GRANTS_CHANGED: "one:private-mail-grants-changed",
}));
vi.mock("@/lib/services/mail-followups-service", () => ({
  MailFollowupsService: { account: mocks.account, check: mocks.check },
}));
vi.mock("@/lib/services/pod-scheduled-tasks", () => ({
  MAIL_FOLLOWUP_TEMPLATE: "agent_email.send_followup.v1",
  PodScheduledTasksClient: class {
    status = mocks.schedulerStatus;
    control = mocks.schedulerControl;
  },
}));

const session = { userId: "owner-b", vaultKey: "test-key", vaultOwnerToken: "test-token" };
const unlocked = { ...session, isVaultUnlocked: true, ownerTokenStatus: "valid" };
const grant = {
  accountId: "b".repeat(32),
  credentialId: "55555555-5555-4555-8555-555555555555",
  email: "reader@example.test",
  status: "connected",
  capabilities: { read: true },
};
const box = { account: grant.accountId, connection: grant.credentialId, address: grant.email };
const promise = {
  account: box.account, connection: box.connection, source_kind: "mail_thread",
  source: "ms1.original-message-source", thread: "ms1.original-thread-source",
  key: "1".repeat(64), watching: true, document: "signed report",
  title: "Get the signed report", participant: "Professor", debtor: "professor@example.test",
  waiting_on: "participant", fulfilment: "Professor sends the signed report.",
  quote: "I will send the signed report on the 29th.", promised_wording: "on the 29th",
};
const task = { id: "task-report", sourceAgent: "gmail", status: "pending", revision: 2, mailFollowup: promise };
const received = { source: "ms1.verified-message-source", filename: "signed-report.pdf" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  window.history.replaceState(null, "", "/one/chat");
  mocks.auth.mockReturnValue({
    userId: session.userId, loading: false, isAuthenticated: true, sessionVerificationRequired: false,
  });
  mocks.vault.mockReturnValue(unlocked);
  mocks.load.mockResolvedValue({ tasks: [task] });
  mocks.grants.mockResolvedValue([grant]);
  mocks.routing.mockResolvedValue({ hostingMode: "hussh_pods" });
  mocks.account.mockResolvedValue(box);
  mocks.check.mockResolvedValue(received);
  mocks.update.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

it("starts on vault unlock in Chat and writes only the opted-in task from its current grant", async () => {
  const { TodoListPkmService, buildTodo } =
    await vi.importActual<typeof import("@/lib/services/todo-list-pkm-service")>(
      "@/lib/services/todo-list-pkm-service",
    );
  const watched = {
    ...buildTodo({ id: task.id, title: promise.title, source: "gmail", type: "automatic" }),
    ...task,
  };
  let stored: Record<string, unknown> = { _private: { tasks: [
    { ...watched, id: "wrong-grant", mailFollowup: { ...promise, connection: "former-connection" } },
    { ...watched, id: "opted-out", mailFollowup: { ...promise, watching: false } },
    { ...watched, id: "already-done", status: "done" },
    watched,
  ] } };
  vi.mocked(PersonalKnowledgeModelService.loadDomainData).mockImplementation(async () => stored);
  vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementation(async (write) => {
    expect(write.confirmation.authorizationMode).toBe("owner_mail_watch");
    const plan = await write.build({
      currentDomainData: stored, currentManifest: null, currentEncryptedDomain: null,
      baseFullBlob: {}, attempt: 0, upgradedInSession: false,
    });
    await write.beforeEffect?.();
    stored = plan.domainData;
    return { success: true, saveState: "saved", fullBlob: {} };
  });
  mocks.load.mockImplementation(TodoListPkmService.load);
  mocks.update.mockImplementation(TodoListPkmService.updateMail);
  mocks.vault.mockReturnValue({ ...unlocked, isVaultUnlocked: false });
  const view = render(<MailFollowupsVaultBridge />);
  expect(mocks.load).not.toHaveBeenCalled();

  mocks.vault.mockReturnValue(unlocked);
  view.rerender(<MailFollowupsVaultBridge />);
  await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
  expect(mocks.check).toHaveBeenCalledOnce();
  expect(mocks.check.mock.calls[0].slice(0, 2)).toEqual([box, promise]);
  const { tasks: saved } = await TodoListPkmService.load(session);
  expect(saved.find((item) => item.id === task.id)).toMatchObject({
    status: "done", revision: 3, mailFollowup: { watching: false, received },
  });
  expect(saved.filter((item) => item.status === "pending").map((item) => item.id).sort())
    .toEqual(["opted-out", "wrong-grant"]);
  expect(mocks.schedulerStatus).not.toHaveBeenCalled();
  expect(mocks.schedulerControl).not.toHaveBeenCalled();
});

it("discards evidence arriving after the vault locks even if the transport ignores cancellation", async () => {
  let finish!: (value: typeof received) => void;
  mocks.check.mockReturnValue(new Promise<typeof received>((resolve) => { finish = resolve; }));
  const view = render(<MailFollowupsVaultBridge />);
  await waitFor(() => expect(mocks.check).toHaveBeenCalledOnce());
  const signal: AbortSignal = mocks.check.mock.calls[0][2];

  act(() => {
    advanceVaultSessionEpoch();
    mocks.vault.mockReturnValue({ ...unlocked, isVaultUnlocked: false });
    view.rerender(<MailFollowupsVaultBridge />);
  });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(received); });
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.schedulerControl).not.toHaveBeenCalled();
});

it("rechecks on return after signing out during a pending read", async () => {
  let finish!: (value: typeof received) => void;
  mocks.check.mockReturnValueOnce(new Promise<typeof received>((resolve) => { finish = resolve; }));
  const view = render(<MailFollowupsVaultBridge />);
  await waitFor(() => expect(mocks.check).toHaveBeenCalledOnce());
  const owner = mocks.auth.mock.results[0].value;
  mocks.auth.mockReturnValue({ ...owner, userId: null, isAuthenticated: false });
  view.rerender(<MailFollowupsVaultBridge />);
  await act(async () => { finish(received); });
  expect(mocks.update).not.toHaveBeenCalled();
  mocks.auth.mockReturnValue(owner);
  view.rerender(<MailFollowupsVaultBridge />);
  await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
});

it("does not start a second check when page and visibility events overlap a pending check", async () => {
  let finish!: (value: typeof received) => void;
  mocks.check.mockReturnValue(new Promise<typeof received>((resolve) => { finish = resolve; }));
  render(<MailFollowupsVaultBridge />);
  await waitFor(() => expect(mocks.check).toHaveBeenCalledOnce());

  await act(async () => {
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(mocks.check).toHaveBeenCalledOnce();
  await act(async () => { finish(received); });
  await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
});

it("discards a match when the mailbox grant was revoked during the Gmail read", async () => {
  mocks.grants.mockResolvedValueOnce([grant]).mockResolvedValue([]);
  render(<MailFollowupsVaultBridge />);
  await waitFor(() => expect(mocks.grants).toHaveBeenCalledTimes(2));
  expect(mocks.check).toHaveBeenCalledOnce();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.schedulerControl).not.toHaveBeenCalled();
});

it("leaves an empty vault idle until this owner's Tasks change", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  mocks.load.mockResolvedValueOnce({ tasks: [] });
  await act(async () => {
    render(<MailFollowupsVaultBridge />);
    await vi.dynamicImportSettled();
  });
  expect(mocks.load).toHaveBeenCalledOnce();
  const change = { domain: "one_todos", operation: "stored" as const, updatedAt: null, dataVersion: null };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(180_000);
    dispatchLocalPkmDomainChanged({ ...change, userId: "other-owner" });
    dispatchLocalPkmDomainChanged({ ...change, userId: session.userId, domain: "wallet" });
  });
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(mocks.grants).not.toHaveBeenCalled();
  await act(async () => {
    dispatchLocalPkmDomainChanged({ ...change, userId: session.userId });
  });
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(mocks.update).toHaveBeenCalledOnce();
});
