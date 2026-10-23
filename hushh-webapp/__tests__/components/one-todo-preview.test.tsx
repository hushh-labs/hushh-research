import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import { OneTodoPreview } from "@/components/agent/one-todo-preview";
import { agentTodoInput, buildTodo, calendarTodoInput, type TodoItem } from "@/lib/services/todo-list-pkm-service";
import type { CapabilityRead } from "@/lib/services/todo-capability-sources";
import { webcrypto } from "node:crypto";
import { captureReceiptSnapshot, type ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), remove: vi.fn(), epoch: 0,
  events: [] as { id: string; title: string; start: { date: string } }[],
  actionables: [] as FeedActionable[],
  kyc: null as { count: number; workflowId: string } | null,
  calendarLoading: false, calendarError: null as string | null,
  retryCalendar: vi.fn(), retryEvents: vi.fn(), retryFeed: vi.fn(), retryKyc: vi.fn(),
  sourceAction: vi.fn(),
  reads: [] as CapabilityRead[],
  gmailStatus: null as { connected: boolean; google_sub: string } | null,
  receiptLoad: vi.fn(),
  resource: { snapshot: null as ReceiptSnapshot | null },
  receiptListeners: new Set<() => void>(),
  resetListeners: new Set<(owner: string) => void>(),
}));
vi.mock("@/lib/services/secure-durable-resource-service", async original => ({
  ...await original<typeof import("@/lib/services/secure-durable-resource-service")>(),
  subscribeDurableOwnerReset: (listener: (owner: string) => void) => { mocks.resetListeners.add(listener); return () => { mocks.resetListeners.delete(listener); }; },
}));
vi.mock("@/lib/mail/receipt-store", () => ({ loadReceiptSnapshot: (...args: unknown[]) => mocks.receiptLoad(...args) }));
vi.mock("@/lib/services/mail-receipt-resource-service", () => ({ MailReceiptResourceService: {
  peek: () => mocks.resource,
  subscribe: (listener: () => void) => { mocks.receiptListeners.add(listener); return () => { mocks.receiptListeners.delete(listener); }; },
} }));
vi.mock("@/lib/todos/use-todo-capability-sources", () => ({ useTodoCapabilitySources: ({ enabled }: { enabled: boolean }) => ({ reads: enabled ? mocks.reads : [], loading: false, error: false, refresh: vi.fn() }) }));
vi.mock("@/lib/services/todo-list-pkm-service", async original => {
  const actual = await original<typeof import("@/lib/services/todo-list-pkm-service")>();
  return { ...actual, TodoListPkmService: { load: mocks.load, setStatus: mocks.save, remove: mocks.remove } };
});
vi.mock("@/lib/feed/use-feed-actionables", () => ({ useFeedActionables: ({ enabled }: { enabled: boolean }) => ({ actionables: enabled ? mocks.actionables : [], loading: false, error: null, retry: mocks.retryFeed }) }));
vi.mock("@/lib/feed/use-feed-briefing", () => ({ useFeedBriefing: ({ enabled }: { enabled: boolean }) => ({ pendingKyc: enabled ? mocks.kyc : null, kycLoading: false, kycError: false, retryKyc: mocks.retryKyc }) }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => ({ connected: true, loaded: true, loading: false, error: null, refresh: mocks.retryCalendar }) }));
vi.mock("@/lib/calendar/use-calendar-upcoming-events", () => ({ useCalendarUpcomingEvents: ({ isConnected }: { isConnected: boolean }) => ({ events: isConnected ? mocks.events : [], loaded: !mocks.calendarLoading, loading: mocks.calendarLoading, error: mocks.calendarError, refresh: mocks.retryEvents }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => ({ status: mocks.gmailStatus }) }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => mocks.epoch, isVaultSessionEpochCurrent: (epoch: number) => epoch === mocks.epoch, subscribeVaultSessionEpoch: () => () => {} }));

const props = (uid = "owner", unlocked = true) => ({
  user: { uid, getIdToken: vi.fn().mockResolvedValue("fixture") } as unknown as User,
  vaultKey: unlocked ? "fixture-key" : null,
  vaultOwnerToken: unlocked ? "fixture-token" : null,
  isVaultUnlocked: unlocked,
});
const event = { id: "event-1", title: "Upcoming call", start: { date: "2099-01-01" } };
const actionable = {
  id: "review-1", todo: { source: "drive", title: "Review files", href: "/one/consent" },
  actions: [{ key: "allow", run: mocks.sourceAction }],
} as unknown as FeedActionable;
const select = (title: string) => screen.getByRole("checkbox", { name: `Mark ${title} as completed` });
const dueSnapshot = () => captureReceiptSnapshot([{ id: 1, gmail_message_id: "synthetic-message", source_id: "synthetic-source", merchant_name: "Acme Cloud", amount: 19, currency: "USD", status: "overdue", attention_state: "needs_attention", attention_reason: "overdue", transaction_date: "2099-01-01" }], "mail-account", { partial: false, truncated: false, source_count: 1, window_from: null, window_to: null, source: "gmail_live" });

describe("One profile To-do live-source parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch = 0;
    mocks.reads = [];
    mocks.gmailStatus = null;
    mocks.resource = { snapshot: null };
    mocks.receiptListeners.clear();
    mocks.resetListeners.clear();
    mocks.receiptLoad.mockResolvedValue(null);
    vi.stubGlobal("crypto", webcrypto);
    publishValidatedAuthSessionOwner("owner");
    mocks.events = [];
    mocks.actionables = [];
    mocks.kyc = null;
    mocks.calendarLoading = false;
    mocks.calendarError = null;
    mocks.load.mockResolvedValue({ tasks: [] });
    mocks.save.mockResolvedValue({ success: true });
    mocks.remove.mockResolvedValue({ success: true });
  });

  it("fetches Calendar, explicit agent tasks and KYC even when saved tasks are empty", async () => {
    mocks.events = [event];
    mocks.actionables = [actionable, actionable, { ...actionable, id: "history", todo: undefined }];
    mocks.kyc = { count: 2, workflowId: "kyc-1" };
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText(event.title)).toBeVisible();
    expect(screen.getAllByText("Review files")).toHaveLength(1);
    expect(screen.getByText("Review 2 information requests")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.sourceAction).not.toHaveBeenCalled();
  });

  it.each(["pending", "done", "deleted"] as const)("projects Mail and Calendar while respecting %s Mail state", async status => {
    const mail = { capability: "gmail" as const, key: "mail:opaque-owner-key", summary: "Reply about the meeting", pendingTitle: "Reply about the meeting", href: "/one/gmail" };
    mocks.events = [event];
    mocks.reads = [{ coverage: { capability: "gmail", count: 1, status: "incomplete" }, evidence: [mail] }];
    if (status !== "pending") mocks.load.mockResolvedValue({ tasks: [{ ...buildTodo(agentTodoInput(mail.key, { source: "gmail", title: mail.pendingTitle, href: mail.href })!), status }] });
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText(event.title)).toBeVisible();
    if (status === "pending") expect(screen.getByText(mail.pendingTitle)).toBeVisible();
    else expect(screen.queryByText(mail.pendingTitle)).not.toBeInTheDocument();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.sourceAction).not.toHaveBeenCalled();
  });

  it("restores due Mail payments without trusting warm plaintext or opening Mail first", async () => {
    const snapshot = await dueSnapshot();
    mocks.gmailStatus = { connected: true, google_sub: "mail-account" };
    mocks.resource = { snapshot };
    let resolve!: (value: { value: ReceiptSnapshot }) => void;
    mocks.receiptLoad.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<OneTodoPreview {...props()} />);
    expect(screen.queryByText("Acme Cloud")).not.toBeInTheDocument();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.receiptLoad).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token" }), "mail-account"));
    await act(async () => resolve({ value: snapshot }));
    expect(await screen.findByText("Acme Cloud")).toBeVisible();
    expect(screen.getByText("Payment overdue")).toBeVisible();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains a saved overdue payment when its original email is unavailable", async () => {
    const saved = await dueSnapshot();
    const row = saved.rows[0];
    const snapshot: ReceiptSnapshot = {
      ...saved,
      schema: "mail_receipt_snapshot.v2",
      sync: {
        checkpoint: null, aliases: {}, unavailable: [row.events[0].ref], archive_refs: [],
        records: [{ row, source_time: null, detail_ref: null }], pending: null,
      },
    };
    mocks.gmailStatus = { connected: true, google_sub: "mail-account" };
    mocks.receiptLoad.mockResolvedValue({ value: snapshot });
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Acme Cloud")).toBeVisible();
    expect(screen.getByText("Payment overdue")).toBeVisible();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("revalidates changed vault credentials and never falls back to warm plaintext after failure", async () => {
    const snapshot = await dueSnapshot();
    mocks.gmailStatus = { connected: true, google_sub: "mail-account" };
    mocks.resource = { snapshot };
    mocks.receiptLoad.mockResolvedValueOnce({ value: snapshot }).mockRejectedValueOnce(new Error("Key changed"));
    const view = render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Acme Cloud")).toBeVisible();
    view.rerender(<OneTodoPreview {...props()} vaultKey="replacement-key" />);
    expect(screen.queryByText("Acme Cloud")).not.toBeInTheDocument();
    expect(await screen.findByText("Some tasks could not refresh.")).toBeVisible();
    expect(screen.queryByText("Acme Cloud")).not.toBeInTheDocument();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
  });

  it.each(["lock", "owner", "account", "epoch"])("rejects a late Mail restoration after %s changes", async change => {
    const snapshot = await dueSnapshot();
    mocks.gmailStatus = { connected: true, google_sub: "mail-account" };
    let resolve!: (value: { value: ReceiptSnapshot }) => void;
    mocks.receiptLoad.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const view = render(<OneTodoPreview {...props()} />);
    await waitFor(() => expect(mocks.receiptLoad).toHaveBeenCalledOnce());
    if (change === "epoch") mocks.epoch += 1;
    if (change === "account") mocks.gmailStatus = { connected: true, google_sub: "other-account" };
    if (change === "owner") publishValidatedAuthSessionOwner("other");
    view.rerender(<OneTodoPreview {...props(change === "owner" ? "other" : "owner", change !== "lock")} />);
    await act(async () => resolve({ value: snapshot }));
    expect(screen.queryByText("Acme Cloud")).not.toBeInTheDocument();
  });

  it("updates payment projection when the existing Mail publisher changes", async () => {
    const snapshot = await dueSnapshot();
    mocks.gmailStatus = { connected: true, google_sub: "mail-account" };
    mocks.receiptLoad.mockResolvedValueOnce({ value: snapshot }).mockResolvedValueOnce(null);
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Acme Cloud")).toBeVisible();
    await act(async () => {
      mocks.resource = { snapshot };
      mocks.receiptListeners.forEach(listener => listener());
    });
    await waitFor(() => expect(mocks.receiptLoad).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Acme Cloud")).not.toBeInTheDocument());
  });

  it("observes owner resets after cold restoration before Mail has published", async () => {
    mocks.gmailStatus = { connected: true, google_sub: "mail-account" };
    mocks.receiptLoad.mockResolvedValueOnce({ value: await dueSnapshot() }).mockResolvedValueOnce(null);
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Acme Cloud")).toBeVisible();
    await act(async () => mocks.resetListeners.forEach(listener => listener("other-owner")));
    expect(mocks.receiptLoad).toHaveBeenCalledOnce();
    await act(async () => mocks.resetListeners.forEach(listener => listener("owner")));
    await waitFor(() => expect(screen.queryByText("Acme Cloud")).not.toBeInTheDocument());
    expect(mocks.receiptLoad).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect receipts from an in-flight read after owner reset", async () => {
    mocks.gmailStatus = { connected: true, google_sub: "mail-account" };
    let resolve!: (value: { value: ReceiptSnapshot }) => void;
    mocks.receiptLoad.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<OneTodoPreview {...props()} />);
    await waitFor(() => expect(mocks.receiptLoad).toHaveBeenCalledOnce());
    await act(async () => mocks.resetListeners.forEach(listener => listener("owner")));
    await act(async () => resolve({ value: await dueSnapshot() }));
    expect(screen.queryByText("Acme Cloud")).not.toBeInTheDocument();
  });

  it("reconciles saved completion and deletion before showing live sources", async () => {
    mocks.events = [event];
    mocks.actionables = [actionable];
    const calendar = buildTodo(calendarTodoInput(event)!);
    const agent = buildTodo(agentTodoInput(actionable.id, actionable.todo!)!);
    mocks.load.mockResolvedValue({ tasks: [{ ...calendar, status: "done" }, { ...agent, status: "deleted" }] });
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(screen.queryByText(event.title)).not.toBeInTheDocument();
    expect(screen.queryByText("Review files")).not.toBeInTheDocument();
  });

  it("keeps a live completion hidden through later renders without executing its source", async () => {
    mocks.actionables = [actionable];
    const view = render(<OneTodoPreview {...props()} />);
    await screen.findByText("Review files");
    fireEvent.click(select("Review files"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: "done", task: expect.objectContaining({ title: "Review files" }) })));
    view.rerender(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(mocks.sourceAction).not.toHaveBeenCalled();
  });

  it("rolls back a resolved unsuccessful write and offers retry", async () => {
    mocks.events = [event];
    mocks.save.mockResolvedValue({ success: false });
    render(<OneTodoPreview {...props()} />);
    await screen.findByText(event.title);
    fireEvent.click(select(event.title));
    expect(await screen.findByText("Your saved tasks could not refresh.")).toBeVisible();
    expect(screen.getByText(event.title)).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("retains saved rows on a source failure, retries sources, and avoids false empty success", async () => {
    mocks.calendarError = "Unavailable";
    mocks.load.mockResolvedValue({ tasks: [buildTodo({ title: "Existing saved task" })] });
    const view = render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Some tasks could not refresh.")).toBeVisible();
    expect(await screen.findByText("Existing saved task")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    mocks.calendarError = null;
    mocks.events = [event];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    view.rerender(<OneTodoPreview {...props()} />);
    expect(await screen.findByText(event.title)).toBeVisible();
    expect(mocks.retryCalendar).toHaveBeenCalledOnce();
    expect(mocks.retryEvents).toHaveBeenCalledOnce();
    expect(mocks.retryFeed).toHaveBeenCalledOnce();
    expect(mocks.retryKyc).toHaveBeenCalledOnce();
  });

  it("does not report All clear when a live source failed and saved tasks are empty", async () => {
    mocks.calendarError = "Unavailable";
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Some tasks could not refresh.")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("shows saved items while Calendar is still loading", async () => {
    mocks.calendarLoading = true;
    mocks.load.mockResolvedValue({ tasks: [buildTodo({ title: "Saved task" })] });
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Saved task")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
  });

  it("retries a failed saved read rather than displaying an empty success", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Read unavailable"));
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Your saved tasks could not refresh.")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    mocks.load.mockResolvedValue({ tasks: [buildTodo({ title: "Recovered item" })] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered item")).toBeVisible();
  });

  it("keeps a dismissed live Calendar task hidden and persists its tombstone", async () => {
    mocks.events = [event];
    const view = render(<OneTodoPreview {...props()} />);
    await screen.findByText(event.title);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${event.title}` }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ sourceAgent: "calendar", title: event.title }) })));
    view.rerender(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(screen.queryByText(event.title)).not.toBeInTheDocument();
  });

  it("does not show live tasks before saved dismissal state finishes loading", async () => {
    mocks.events = [event];
    let resolve!: (value: { tasks: TodoItem[] }) => void;
    mocks.load.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<OneTodoPreview {...props()} />);
    expect(screen.queryByText(event.title)).not.toBeInTheDocument();
    const task = buildTodo(calendarTodoInput(event)!);
    await act(async () => resolve({ tasks: [{ ...task, status: "deleted" }] }));
    expect(await screen.findByText("All clear.")).toBeVisible();
  });

  it.each(["lock", "owner", "epoch"])("drops late saved reads after a %s change", async change => {
    let resolve!: (value: { tasks: TodoItem[] }) => void;
    mocks.load.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const view = render(<OneTodoPreview {...props()} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    if (change === "epoch") mocks.epoch += 1;
    view.rerender(<OneTodoPreview {...props(change === "owner" ? "other" : "owner", change !== "lock")} />);
    await act(async () => resolve({ tasks: [buildTodo({ title: "Private old task" })] }));
    expect(screen.queryByText("Private old task")).not.toBeInTheDocument();
    if (change === "lock") expect(screen.getByText("Unlock your vault to view your to-do list.")).toBeVisible();
  });
});
