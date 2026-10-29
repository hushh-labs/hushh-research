import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import type { GmailInformationRequestWorkflow } from "@/lib/services/gmail-information-requests-service";
import type { GmailLiveReceiptScanResponse, ReceiptListItem } from "@/lib/services/gmail-receipts-service";

const fixture = vi.hoisted(() => {
  const resource = { snapshot: null as unknown, hydrated: true, refreshing: false, error: null, attemptedAt: 0, progress: null };
  return {
    user: { getIdToken: async () => "synthetic-id-token" },
    connected: true,
    resource,
    empty: { ...resource, hydrated: false },
    hydrate: vi.fn(),
    list: vi.fn(),
    toast: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("sonner", () => ({ toast: fixture.toast }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: fixture.user, userId: "synthetic-owner" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: true, vaultKey: "12".repeat(32), vaultOwnerToken: "synthetic-owner-token" }),
}));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: fixture.connected ? { connected: true, needs_reauth: false, google_sub: "synthetic-account" } : null,
  }),
}));
vi.mock("@/lib/services/mail-receipt-resource-service", () => ({
  MailReceiptResourceService: {
    subscribe: () => () => undefined,
    peek: (owner: string, account: string) =>
      owner === "synthetic-owner" && account === "synthetic-account" ? fixture.resource : fixture.empty,
    hydrate: fixture.hydrate,
  },
}));
vi.mock("@/lib/services/gmail-information-requests-service", () => ({
  GmailInformationRequestsService: { list: fixture.list },
}));

import { MailAttentionStack, MAIL_BRIEF_PROMPT } from "@/components/agent/mail-attention-stack";
import {
  forgetMailAttentionDismissals,
  isMailAttentionHidden,
  MAIL_ATTENTION_SNOOZE_MS,
  mailAttentionStateKey,
  mailAttentionStorageKey,
  markMailAttentionDone,
  readMailAttentionDismissals,
  snoozeMailAttention,
} from "@/lib/agent/mail-attention-dismissals";
import { mergeReceiptSnapshot } from "@/lib/mail/receipt-continuity";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const OWNER = "synthetic-owner";
const DAY = 86_400_000;

type StoredChoices = { snoozed: Record<string, number>; done: Record<string, number> };
const storedChoices = () =>
  JSON.parse(window.localStorage.getItem(mailAttentionStorageKey(OWNER)) ?? "{}") as StoredChoices;

function receipt(id: number, merchant: string, ageDays: number, fields: Partial<ReceiptListItem>): ReceiptListItem {
  return {
    id, source_id: `synthetic-source-${id}`, receipt_key: `synthetic-source-${id}`, event_id: id.toString(16).padStart(64, "0"),
    source_kind: "gmail_live", gmail_message_id: `synthetic-message-${id}`, merchant_name: merchant,
    gmail_internal_date: new Date(Date.now() - ageDays * DAY).toISOString(), category: "Bills", category_confidence: 1,
    amount: 15.49, amount_decimal: "15.49", currency: "USD", document_kind: "invoice", event_type: "purchase",
    recurrence: "one_time", attention_state: "none", attention_reason: null, attention_is_prediction: false, ...fields,
  };
}

async function snapshotOf(items: ReceiptListItem[]): Promise<ReceiptSnapshot> {
  const response = { items, page: 1, per_page: items.length, returned_count: items.length, has_more: false, checkpoint: null,
    coverage: { reached_limit: false, listed_count: items.length, max_pages: 50 } } as unknown as GmailLiveReceiptScanResponse;
  return mergeReceiptSnapshot(null, items, "synthetic-account", response, [], true);
}

const overdue = { status: "overdue", attention_state: "needs_attention", attention_reason: "overdue" } as const;
// Classified, but not a stated current fact: a prediction, a review guess and an old notice.
const noise = [
  receipt(2, "Synthetic Music", 2, { recurrence: "recurring", attention_state: "coming_up", attention_reason: "renewal_due", attention_is_prediction: true }),
  receipt(3, "Synthetic Store", 1, { attention_state: "needs_review", attention_reason: "low_confidence" }),
  receipt(4, "Synthetic Utility", 60, overdue),
];
const request: GmailInformationRequestWorkflow = {
  workflow_id: "synthetic-workflow", status: "detected", gmail_thread_id: "synthetic-thread",
  received_at: new Date(Date.now() - 2 * DAY).toISOString(), classification_confidence: 0.9,
  requested_field_labels: ["full_name", "pan_number"], attachment_review_required: false,
  candidate_scopes: [{ scope: "attr.identity.pan", domain: "identity", label: "Saved PAN", segment_ids: [] }],
};
let factualSnapshot: ReceiptSnapshot;
let noiseSnapshot: ReceiptSnapshot;

beforeAll(async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  factualSnapshot = await snapshotOf([receipt(1, "Synthetic Streaming", 3, overdue), ...noise]);
  noiseSnapshot = await snapshotOf(noise);
});

beforeEach(() => {
  forgetMailAttentionDismissals(OWNER);
  fixture.connected = true;
  fixture.resource.snapshot = factualSnapshot;
  fixture.list.mockResolvedValue({ workflows: [request], limit: 10, offset: 0, next_offset: null, total_count: 1 });
});

afterEach(() => cleanup());

describe("MailAttentionStack", () => {
  it("renders nothing without a connected Gmail or a factual item", async () => {
    fixture.connected = false;
    const disconnected = render(<MailAttentionStack onAskOne={vi.fn()} />);
    await act(async () => {});
    expect(disconnected.container).toBeEmptyDOMElement();
    expect(fixture.list).not.toHaveBeenCalled();
    disconnected.unmount();

    fixture.connected = true;
    fixture.resource.snapshot = noiseSnapshot;
    fixture.list.mockResolvedValue({ workflows: [{ ...request, status: "ignored" }], limit: 10, offset: 0, next_offset: null, total_count: 0 });
    const quiet = render(<MailAttentionStack onAskOne={vi.fn()} />);
    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(quiet.container).toBeEmptyDOMElement();
  });

  it("shows a factual overdue receipt and a details request with safe fields only", async () => {
    const onAskOne = vi.fn();
    render(<MailAttentionStack onAskOne={onAskOne} />);
    const stack = await screen.findByTestId("mail-attention-stack");
    await within(stack).findByText("1 overdue payment · 1 request for your details");
    const card = screen.getByTestId("mail-attention-card");
    expect(within(card).getByText("Synthetic Streaming")).toBeInTheDocument();
    expect(within(card).getByText("Overdue · $15.49 · 3 days ago")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    const rows = within(screen.getByRole("list", { name: "Mail items" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Synthetic Streaming"), expect.stringContaining("Full name, Pan number"),
    ]);
    expect(stack).not.toHaveTextContent(/Synthetic (Music|Store|Utility)|Saved PAN|synthetic-thread/);
    fireEvent.click(screen.getByRole("button", { name: "Brief me on my mail" }));
    expect(onAskOne).toHaveBeenCalledWith(MAIL_BRIEF_PROMPT);
    expect(MAIL_BRIEF_PROMPT).toBe("Brief me on my mail");
  });

  it("disables only Brief me while the chat cannot take a prompt", async () => {
    const onAskOne = vi.fn();
    const view = render(<MailAttentionStack onAskOne={onAskOne} onOpenItem={vi.fn()} briefDisabled />);
    const stack = await screen.findByTestId("mail-attention-stack");
    const toggle = await within(stack).findByRole("button", { name: "Show all" });
    const brief = within(stack).getByRole("button", { name: "Brief me on my mail" });
    const disabled = () => within(stack).getAllByRole("button").filter((button) => button.matches(":disabled"));
    // Remind me later, Mark as done, each item, Show all and Hide stay usable.
    expect(disabled()).toEqual([brief]);
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName("Hide");
    expect(disabled()).toEqual([brief]);
    fireEvent.click(brief);
    expect(onAskOne).not.toHaveBeenCalled();
    // Once the chat can take a prompt again, so can Brief me.
    view.rerender(<MailAttentionStack onAskOne={onAskOne} onOpenItem={vi.fn()} />);
    expect(disabled()).toEqual([]);
  });
});

describe("MailAttentionStack choices", () => {
  it("leaves focus alone when a tap clears the stack, so no phone keyboard opens", async () => {
    const onEmpty = vi.fn();
    render(<MailAttentionStack onAskOne={vi.fn()} onEmpty={onEmpty} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done: Synthetic Streaming" }), { detail: 1 });
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done: Request for your details" }), { detail: 1 });
    expect(screen.queryByTestId("mail-attention-stack")).not.toBeInTheDocument();
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it("hides items on Remind me later and Mark as done, storing only opaque keys", async () => {
    const onEmpty = vi.fn(() => screen.getByRole("textbox", { name: "Message One" }).focus());
    render(<><MailAttentionStack onAskOne={vi.fn()} onEmpty={onEmpty} /><textarea aria-label="Message One" /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me later: Synthetic Streaming" }));
    expect(screen.queryByText("Synthetic Streaming")).not.toBeInTheDocument();
    const [message, options] = fixture.toast.mock.calls[0]!;
    expect(message).toBe("Hidden for 24 hours");
    act(() => options.action.onClick());
    expect(await screen.findByText("Synthetic Streaming")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remind me later: Synthetic Streaming" }));
    expect(onEmpty).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done: Request for your details" }));
    expect(screen.queryByTestId("mail-attention-stack")).not.toBeInTheDocument();
    // The surface that owns the stack places focus once nothing is left in it.
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message One" }));
    const stored = window.localStorage.getItem(mailAttentionStorageKey(OWNER)) ?? "";
    const { snoozed, done } = JSON.parse(stored) as { snoozed: Record<string, number>; done: Record<string, number> };
    expect([Object.keys(snoozed).length, Object.keys(done).length]).toEqual([1, 1]);
    expect([...Object.keys(snoozed), ...Object.keys(done)].every((key) => /^[0-9a-z]{14}$/.test(key))).toBe(true);
    expect(stored).not.toMatch(/synthetic|receipt|request|overdue|15\.49|full name/i);
    forgetMailAttentionDismissals(OWNER);
    expect(window.localStorage.getItem(mailAttentionStorageKey(OWNER))).toBeNull();
  });

  it("brings a reminder back after 24 hours", () => {
    const key = mailAttentionStateKey("receipt:group-synthetic", "overdue:synthetic-event");
    snoozeMailAttention(OWNER, key, 0);
    const dismissals = readMailAttentionDismissals(OWNER);
    expect(isMailAttentionHidden(dismissals, key, MAIL_ATTENTION_SNOOZE_MS - 1)).toBe(true);
    expect(isMailAttentionHidden(dismissals, key, MAIL_ATTENTION_SNOOZE_MS + 1)).toBe(false);
  });

  it("expands and collapses from the toggle and from Back, keeping focus on the toggle", async () => {
    render(<MailAttentionStack onAskOne={vi.fn()} onOpenItem={vi.fn()} />);
    const toggle = await screen.findByRole("button", { name: "Show all" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Hide");
    expect(document.activeElement).toBe(toggle);
    // Back removes the rows; focus on one returns to the toggle, not the page.
    within(screen.getByRole("list", { name: "Mail items" })).getAllByRole("button")[0]!.focus();
    act(() => { expect(unwindBackLayer("/")).toBe(true); });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Mail items" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName("Show all");
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps another tab's choice when this tab writes after it", () => {
    const mine = mailAttentionStateKey("receipt:group-synthetic", "overdue:synthetic-event");
    const theirs = mailAttentionStateKey("request:synthetic-workflow", "detected:");
    expect(readMailAttentionDismissals(OWNER).done).toEqual({});
    // Another tab writes after this page read the record; its event comes later.
    window.localStorage.setItem(mailAttentionStorageKey(OWNER), JSON.stringify({ snoozed: {}, done: { [theirs]: 1 } }));
    markMailAttentionDone(OWNER, mine, 2);
    expect(Object.keys(storedChoices().done).sort()).toEqual([mine, theirs].sort());
    expect(isMailAttentionHidden(readMailAttentionDismissals(OWNER), theirs, 3)).toBe(true);
  });

  it("never brings back a choice another tab reset, and places focus by what the write leaves", async () => {
    const onEmpty = vi.fn();
    render(<MailAttentionStack onAskOne={vi.fn()} onEmpty={onEmpty} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done: Synthetic Streaming" }));
    // Another tab resets, and this tab chooses again before hearing about it.
    const key = mailAttentionStorageKey(OWNER);
    window.localStorage.removeItem(key);
    const later = screen.getByRole("button", { name: "Remind me later: Request for your details" });
    later.focus();
    fireEvent.click(later);
    expect(await screen.findByText("Synthetic Streaming")).toBeInTheDocument();
    expect(storedChoices().done).toEqual({});
    // Acting on the only card brought another back, so focus stays in the stack.
    expect(onEmpty).not.toHaveBeenCalled();
    expect(screen.getByTestId("mail-attention-stack").contains(document.activeElement)).toBe(true);
    // Hearing about a Reset is enough on its own: the reminder goes too.
    const { snoozed: reminder } = storedChoices();
    window.localStorage.removeItem(key);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key })); });
    expect(screen.getByText("1 overdue payment · 1 request for your details")).toBeInTheDocument();
    // Another tab marks the request done, unheard: acting on one of two cards empties the stack.
    window.localStorage.setItem(key, JSON.stringify({ snoozed: {}, done: reminder }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as done: Synthetic Streaming" }));
    expect(screen.queryByTestId("mail-attention-stack")).not.toBeInTheDocument();
    expect(onEmpty).toHaveBeenCalledTimes(1);
  });

  it("hears another tab's Reset and choices while the stack is closed", async () => {
    const key = mailAttentionStorageKey(OWNER);
    const otherTab = (value: string | null) => {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
    };
    const first = render(<MailAttentionStack onAskOne={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done: Synthetic Streaming" }));
    const done = window.localStorage.getItem(key);
    // A conversation opens, so the stack unmounts; meanwhile another tab resets.
    first.unmount();
    otherTab(null);
    const second = render(<MailAttentionStack onAskOne={vi.fn()} />);
    expect(await screen.findByText("Synthetic Streaming")).toBeInTheDocument();
    // Closed again, another tab marks the same item done.
    second.unmount();
    otherTab(done);
    render(<MailAttentionStack onAskOne={vi.fn()} />);
    expect(await screen.findByText("Request for your details")).toBeInTheDocument();
    expect(screen.queryByText("Synthetic Streaming")).not.toBeInTheDocument();
  });

  it("keeps every choice while storage is full, until it takes a write or a Reset", async () => {
    const key = mailAttentionStorageKey(OWNER);
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    onTestFinished(() => full.mockRestore());
    render(<MailAttentionStack onAskOne={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done: Synthetic Streaming" }));
    // The second choice builds on the first, which storage never received.
    fireEvent.click(screen.getByRole("button", { name: "Mark as done: Request for your details" }));
    expect(screen.queryByTestId("mail-attention-stack")).not.toBeInTheDocument();
    // A Reset in another tab brings back what this page could not save.
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key })); });
    expect(screen.getByText("1 overdue payment · 1 request for your details")).toBeInTheDocument();
    // An unsaved choice outlasts another tab's write, and is saved with the
    // next write storage takes.
    fireEvent.click(screen.getByRole("button", { name: "Mark as done: Synthetic Streaming" }));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: "{}" })); });
    expect(screen.queryByText("Synthetic Streaming")).not.toBeInTheDocument();
    full.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Remind me later: Request for your details" }));
    expect(screen.queryByTestId("mail-attention-stack")).not.toBeInTheDocument();
    const { snoozed, done } = storedChoices();
    expect([Object.keys(snoozed).length, Object.keys(done).length]).toEqual([1, 1]);
  });
});
