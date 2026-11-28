/**
 * The three sections as a person meets them. Synthetic items only: this proves
 * what each card says, what each button hands on, and that a slow, failed or
 * empty read is never worded as the same thing.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MailBriefSections, type MailBriefSectionsProps } from "@/components/gmail/mail-brief";
import type {
  AttentionItem,
  CompletedItem,
  MailBrief,
  MailCompleted,
  UpdateItem,
} from "@/lib/mail/mail-brief-client";
import { MailOverviewError } from "@/lib/mail/mail-overview-client";
import type { BriefPart } from "@/lib/mail/use-mail-brief";

afterEach(cleanup);

const sid = (name: string) => `ms1.${name.padEnd(24, "x")}`;
const evidence = (name: string, over: Partial<AttentionItem["evidence"][number]> = {}) => ({
  sourceId: sid(name),
  from: "Maya Rao",
  on: "2026-11-19",
  direction: "received" as const,
  quote: "I will send the final brand assets by 21 Nov",
  ...over,
});

function attention(name: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `att_${name}`,
    kind: "follow_up",
    title: `Task ${name}`,
    reason: "They promised it and it has not arrived.",
    context: null,
    person: "Maya Rao",
    due: null,
    term: null,
    action: { kind: "draft_followup", sourceId: sid(name), draft: null },
    evidence: [evidence(name)],
    ...over,
  };
}

const update = (over: Partial<UpdateItem> = {}): UpdateItem => ({
  id: "upd_1",
  kind: "approval",
  title: "Proposal approved",
  line: "Scope and Rs 2.4 lakh budget confirmed.",
  person: "Priya Nair",
  on: "2026-11-22",
  action: { kind: "thank", sourceId: sid("yes"), draft: "Thank you, Priya." },
  evidence: [evidence("sent", { direction: "sent", from: "You" }), evidence("yes", { from: "Priya Nair" })],
  ...over,
});

const done = (over: Partial<CompletedItem> = {}): CompletedItem => ({
  id: "done_1",
  title: "Pricing sheet sent to Priya",
  line: null,
  sentAt: "2026-11-22T09:38:00.000Z",
  to: "Priya Nair",
  sourceId: sid("sentmail"),
  ...over,
});

const part = <T,>(data: T | null, over: Partial<BriefPart<T>> = {}): BriefPart<T> => ({
  status: data ? "ready" : "idle",
  data,
  error: null,
  refreshing: false,
  fetchedAt: data ? Date.UTC(2026, 10, 26, 9, 0) : 0,
  ...over,
});

const briefOf = (items: AttentionItem[] = [], updates: UpdateItem[] = [], messages = 12): MailBrief => ({
  account: "acct",
  generatedAt: "2026-11-26T09:00:00.000Z",
  coverage: { messages, windowDays: 21, mayBePartial: false },
  attention: items,
  updates,
});
const completedOf = (items: CompletedItem[] = []): MailCompleted => ({ account: "acct", items });

function props(over: Partial<MailBriefSectionsProps> = {}): MailBriefSectionsProps {
  return {
    brief: part(briefOf([attention("a")])),
    completed: part(completedOf()),
    receiptUpdates: [],
    ownerInitial: "N",
    draftBusy: null,
    draftFailure: null,
    onWhy: vi.fn(),
    onDraft: vi.fn(),
    onOpenReceipt: vi.fn(),
    onViewSent: vi.fn(),
    onOpenFollowups: vi.fn(),
    onRetry: vi.fn(),
    onReconnect: vi.fn(),
    onUnlock: vi.fn(),
    ...over,
  };
}

describe("Needs your attention", () => {
  it("shows who it is with, the date or term the email states, and one action per card", () => {
    render(
      <MailBriefSections
        {...props({
          brief: part(
            briefOf([
              attention("a", {
                title: "Get the signed document",
                context: "IIT KGP",
                due: { date: "2026-11-20", role: "promised", label: "Promised 20 November" },
              }),
              attention("b", { title: "Get the final brand assets", person: "Maya Rao" }),
              attention("c", {
                kind: "reply",
                title: "Choose the payment term",
                person: "Morgan Lee",
                term: "30 to 45 days",
                action: { kind: "draft_reply", sourceId: sid("c"), draft: null },
              }),
            ]),
          ),
        })}
      />,
    );

    const cards = screen.getAllByTestId("attention-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText("IIT KGP · Follow-up")).toBeVisible();
    expect(within(cards[0]!).getByRole("heading", { name: "Get the signed document" })).toBeVisible();
    expect(within(cards[0]!).getByTestId("attention-due")).toHaveTextContent("Promised 20 November");
    expect(within(cards[0]!).getByRole("button", { name: "Draft follow-up" })).toBeVisible();
    // Without a stated context the label is the person.
    expect(within(cards[1]!).getByText("Maya Rao")).toBeVisible();
    expect(within(cards[2]!).getByTestId("attention-term")).toHaveTextContent("30 to 45 days");
    expect(within(cards[2]!).getByRole("button", { name: "Draft reply" })).toBeVisible();
    // Only the first card is the primary action.
    const classes = cards.map((card) => within(card).getByTestId("attention-action").className);
    expect(classes.map((value) => value.includes("pillPrimary"))).toEqual([true, false, false]);
  });

  it("shows at most three and links to Follow-ups with the real count", () => {
    const onOpenFollowups = vi.fn();
    const items = ["a", "b", "c", "d", "e"].map((name) => attention(name));
    render(<MailBriefSections {...props({ brief: part(briefOf(items)), onOpenFollowups })} />);

    expect(screen.getAllByTestId("attention-card")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "All 5 in Follow-ups" }));
    expect(onOpenFollowups).toHaveBeenCalledOnce();
  });

  it("offers no Follow-ups link when everything is already on screen", () => {
    render(<MailBriefSections {...props({ brief: part(briefOf([attention("a"), attention("b")])) })} />);
    expect(screen.queryByTestId("all-in-followups")).toBeNull();
  });

  it("hands the exact message and any starting text to the draft, and nothing else", () => {
    const onDraft = vi.fn();
    const item = attention("a", { action: { kind: "draft_followup", sourceId: sid("a"), draft: "Could you send it?" } });
    render(<MailBriefSections {...props({ brief: part(briefOf([item])), onDraft })} />);

    fireEvent.click(screen.getByRole("button", { name: "Draft follow-up" }));
    expect(onDraft).toHaveBeenCalledWith({ key: "att_a", sourceId: sid("a"), draft: "Could you send it?" });
  });

  it("says it is preparing while a draft is being made, and why when it could not be", () => {
    const { rerender } = render(<MailBriefSections {...props({ draftBusy: "att_a" })} />);
    const busy = screen.getByRole("button", { name: /preparing/i });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    rerender(
      <MailBriefSections
        {...props({ draftFailure: { key: "att_a", message: "That email can't be found now, so it can't be replied to." } })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("can't be found now");
    expect(screen.getByRole("button", { name: "Draft follow-up" })).toBeEnabled();
  });

  it("opens the evidence for the card it was asked on", () => {
    const onWhy = vi.fn();
    const item = attention("a", { evidence: [evidence("a"), evidence("b", { quote: "Second quote here please" })] });
    render(<MailBriefSections {...props({ brief: part(briefOf([item])), onWhy })} />);

    fireEvent.click(screen.getByRole("button", { name: "Why this?" }));
    expect(onWhy).toHaveBeenCalledWith({
      title: "Task a",
      reason: "They promised it and it has not arrived.",
      evidence: item.evidence,
    });
  });
});

describe("honest states for the brief", () => {
  it("says it is checking, not that nothing needs you", () => {
    render(<MailBriefSections {...props({ brief: part<MailBrief>(null, { status: "loading" }) })} />);
    expect(screen.getAllByLabelText(/checking/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/nothing needs/i)).toBeNull();
  });

  it("says nothing needs you only after a read that found nothing, and how much it checked", () => {
    render(<MailBriefSections {...props({ brief: part(briefOf([], [], 12)) })} />);
    expect(screen.getByText(/No action found in the 12 messages checked from the last 21 days/)).toBeVisible();
    expect(screen.getByText("No changes to report.")).toBeVisible();
  });

  it("says there is no recent mail to check when the mailbox window was empty", () => {
    render(<MailBriefSections {...props({ brief: part(briefOf([], [], 0)) })} />);
    expect(screen.getByText("No recent mail to check yet.")).toBeVisible();
    expect(screen.queryByText(/Nothing needs a reply/)).toBeNull();
  });

  it("never turns a failed check into an empty one, and offers a retry", () => {
    const onRetry = vi.fn();
    render(
      <MailBriefSections
        {...props({
          brief: part<MailBrief>(null, { status: "error", error: new MailOverviewError("brief_unavailable") }),
          onRetry,
        })}
      />,
    );
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("One couldn't check your mail just now");
    expect(screen.queryByText(/nothing needs/i)).toBeNull();
    expect(screen.queryByText("No changes to report.")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(onRetry).toHaveBeenCalled();
  });

  it("keeps the cards on screen and says the refresh failed", () => {
    render(
      <MailBriefSections
        {...props({
          brief: part(briefOf([attention("a")]), { status: "error", error: new MailOverviewError("brief_unavailable") }),
        })}
      />,
    );
    expect(screen.getByTestId("attention-card")).toBeVisible();
    expect(screen.getByText("Couldn't refresh. Showing what One found earlier.")).toBeVisible();
  });

  it("asks to reconnect or unlock when that is what is wrong", () => {
    const onReconnect = vi.fn();
    const onUnlock = vi.fn();
    const { rerender } = render(
      <MailBriefSections
        {...props({ brief: part<MailBrief>(null, { status: "error", error: new MailOverviewError("reconnect_required") }), onReconnect })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Reconnect" })[0]!);
    expect(onReconnect).toHaveBeenCalled();

    rerender(
      <MailBriefSections
        {...props({ brief: part<MailBrief>(null, { status: "error", error: new MailOverviewError("auth_missing") }), onUnlock })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Unlock" })[0]!);
    expect(onUnlock).toHaveBeenCalled();
  });
});

describe("Recent updates", () => {
  it("offers Thank for an approval and hands the approving message on", () => {
    const onDraft = vi.fn();
    render(<MailBriefSections {...props({ brief: part(briefOf([], [update()])), onDraft })} />);

    const row = screen.getByTestId("update-row");
    expect(within(row).getByRole("heading", { name: "Proposal approved" })).toBeVisible();
    expect(within(row).getByText("Scope and Rs 2.4 lakh budget confirmed.")).toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: "Thank Priya" }));
    expect(onDraft).toHaveBeenCalledWith({ key: "upd_1", sourceId: sid("yes"), draft: "Thank you, Priya." });
  });

  it("offers no draft for an update that does not call for one, and still shows why", () => {
    const onWhy = vi.fn();
    const quiet = update({ kind: "change", action: { kind: "none", sourceId: null, draft: null } });
    render(<MailBriefSections {...props({ brief: part(briefOf([], [quiet])), onWhy })} />);

    expect(screen.queryByTestId("update-action")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Why this?" }));
    expect(onWhy).toHaveBeenCalledWith({ title: "Proposal approved", reason: quiet.line, evidence: quiet.evidence });
  });

  it("shows a saved price rise and opens its exact Receipts finding", () => {
    const onOpenReceipt = vi.fn();
    render(
      <MailBriefSections
        {...props({
          brief: part(briefOf()),
          receiptUpdates: [
            {
              findingId: "f_price_1",
              title: "Netflix renewal increases by ₹600",
              line: "You paid ₹1,200. The 26 Nov renewal is ₹1,800.",
            },
          ],
          onOpenReceipt,
        })}
      />,
    );

    expect(screen.queryByText("No changes to report.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Netflix renewal increases by ₹600" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Open in Receipts/ }));
    expect(onOpenReceipt).toHaveBeenCalledWith("f_price_1");
  });
});

describe("Recently completed", () => {
  it("mentions an attachment only when the sent message has it", () => {
    render(
      <MailBriefSections
        {...props({
          completed: part(
            completedOf([done({ line: "Attached: pricing.pdf" }), done({ id: "done_2", title: "Quick note sent to Sam", line: null })]),
          ),
        })}
      />,
    );

    const rows = screen.getAllByTestId("completed-row");
    expect(within(rows[0]!).getByText("Attached: pricing.pdf")).toBeVisible();
    expect(within(rows[1]!).queryByText(/attach/i)).toBeNull();
  });

  it("opens the exact sent message", () => {
    const onViewSent = vi.fn();
    const item = done();
    render(<MailBriefSections {...props({ completed: part(completedOf([item])), onViewSent })} />);

    fireEvent.click(screen.getByRole("button", { name: "View sent email" }));
    expect(onViewSent).toHaveBeenCalledWith(item);
  });

  it("says nothing was sent only after a read that found nothing, and a failure is not that", () => {
    const { rerender } = render(<MailBriefSections {...props({ completed: part(completedOf()) })} />);
    expect(screen.getByText("Nothing sent through One in the last 30 days.")).toBeVisible();

    rerender(
      <MailBriefSections
        {...props({ completed: part<MailCompleted>(null, { status: "error", error: new MailOverviewError("retryable") }) })}
      />,
    );
    expect(screen.queryByText("Nothing sent through One in the last 30 days.")).toBeNull();
    expect(screen.getAllByRole("alert").some((node) => /couldn't load your mail/i.test(node.textContent ?? ""))).toBe(true);
  });
});

describe("freshness", () => {
  it("says when it was updated and offers Refresh, which waits for the read in flight", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<MailBriefSections {...props({ onRetry })} />);
    expect(screen.getByTestId("brief-updated")).toHaveTextContent(/Updated/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(<MailBriefSections {...props({ brief: part(briefOf([attention("a")]), { refreshing: true }), onRetry })} />);
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  });

  it("claims no time before a read has succeeded", () => {
    render(<MailBriefSections {...props({ brief: part<MailBrief>(null, { status: "loading" }), completed: part<MailCompleted>(null) })} />);
    expect(screen.queryByTestId("brief-updated")).toBeNull();
  });
});
