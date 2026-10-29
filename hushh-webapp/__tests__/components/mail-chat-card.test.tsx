import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push }) }));

import { MailChatCard, summarizeMailBrief } from "@/components/agent/mail-chat-card";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";
import {
  MAIL_BRIEF_CATEGORIES,
  MAIL_BRIEF_EXPERIENCE_TYPE,
  receiptSetupExperience,
  type MailBriefExperience,
} from "@/lib/agent/mail-chat-experiences";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const brief = {
  schema_version: "mail_brief.v1",
  checked_at: "2026-10-29T06:00:00Z",
  requested: ["action_items", "payments_due"],
  failed: [],
  counts_by_category: { action_items: 2, payments_due: 1 },
  items: [
    { source_ref: "mail:1", category: "action_items", sender_name: "Priya", subject: "Sign the lease", detail: null,
      state: "active", received_at: "2026-10-29T05:00:00Z", due_at: null, event_at: null },
    { source_ref: "mail:2", category: "payments_due", sender_name: "Acme Cloud", subject: "Invoice overdue", detail: null,
      state: "active", received_at: null, due_at: "2026-10-31T00:00:00Z", event_at: null },
    { source_ref: "mail:3", category: "action_items", sender_name: "Dev", subject: "Old request", detail: null,
      state: "completed", received_at: null, due_at: null, event_at: null },
  ],
  senders: [],
  coverage: { checked: 10, analyzed: 10, unreadable: 0, unnamed_sender_messages: 0, more_mail_outside_page: true, text_shortened: false },
};
const paidBill = {
  source_ref: "mail:4", category: "payments_due", sender_name: "Acme Cloud", subject: "Payment received", detail: null,
  state: "completed", received_at: null, due_at: "2026-10-31T00:00:00Z", event_at: null,
};

function parse(result: unknown) {
  return parseAgentToolResultExperience("ask_email_agent", result);
}

afterEach(cleanup);

describe("Mail brief in chat", () => {
  it("parses the specialist's brief from the ask_email_agent result and keeps the receipt otherwise", () => {
    const experience = parse({ status: "ok", mail_brief: brief, structured: {} });
    expect(experience?.type).toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
    // Negative controls: an unknown category, a broken count or a count the items don't carry never renders a brief.
    expect(parse({ mail_brief: { ...brief, counts_by_category: { blockers: 1 } } })?.type).not.toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
    expect(parse({ mail_brief: { ...brief, counts_by_category: { action_items: -1 } } })?.type).not.toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
    expect(parse({ mail_brief: { ...brief, counts_by_category: { action_items: 3, payments_due: 1 } } })?.type)
      .not.toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
    // A failed kind nobody asked for, or every asked kind failed: no headline could be true.
    expect(parse({ mail_brief: { ...brief, failed: ["meetings"] } })?.type).not.toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
    expect(parse({ mail_brief: { ...brief, failed: ["action_items", "payments_due"] } })?.type)
      .not.toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
  });

  it("shows counts, the open item first, and every item behind Show all until Back", () => {
    const experience = parse({ mail_brief: brief }) as MailBriefExperience;
    expect(summarizeMailBrief(experience)).toBe("1 needs you · 1 payment due");
    render(<MailChatCard experience={experience} />);
    expect(screen.getByText("Sign the lease")).toBeTruthy();
    expect(screen.queryByText("Old request")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show all 3/ }));
    expect(screen.getAllByTestId("mail-brief-item")).toHaveLength(3);
    expect(screen.getByText("Only recent mail was checked.")).toBeTruthy();
    act(() => { expect(unwindBackLayer("/")).toBe(true); });
    expect(screen.getAllByTestId("mail-brief-item")).toHaveLength(1);
  });

  it("counts open items only, so a paid bill never reads as a payment due", () => {
    const counts = { action_items: 0, personal_info: 0, payments_due: 1, security_alerts: 0, meetings: 0 };
    const experience = parse({
      mail_brief: { ...brief, requested: [...MAIL_BRIEF_CATEGORIES], counts_by_category: counts, items: [paidBill] },
    }) as MailBriefExperience;
    // Negative control: counting every finding read "1 payment due" above the paid bill's greyed row.
    expect(summarizeMailBrief(experience)).toBe("Nothing needs you in the mail checked.");
    render(<MailChatCard experience={experience} />);
    // Negative control: under that headline the row itself read "Payment due · Acme Cloud · Due …".
    expect(screen.queryByText(/Payment due/)).toBeNull();
    expect(screen.getByText("Done · Acme Cloud")).toBeTruthy();
  });

  it("never says nothing needs you while a check didn't finish, and says what it couldn't read", () => {
    const experience = parse({ mail_brief: {
      ...brief, requested: [...MAIL_BRIEF_CATEGORIES], failed: ["payments_due"], items: [],
      counts_by_category: { action_items: 0, personal_info: 0, security_alerts: 0, meetings: 0 },
      coverage: { ...brief.coverage, unreadable: 2 },
    } }) as MailBriefExperience;
    render(<MailChatCard experience={experience} />);
    expect(screen.getByText("The checks that finished found nothing that needs you · Couldn't check for payments due"))
      .toBeTruthy();
    expect(screen.getByText("Some messages couldn't be read.")).toBeTruthy();
    expect(screen.queryByText(/Nothing needs you/)).toBeNull();
  });

  it("names what a narrow request checked, even when part of it didn't finish", () => {
    const experience = parse({
      mail_brief: { ...brief, requested: ["meetings"], counts_by_category: { meetings: 0 }, items: [] },
    }) as MailBriefExperience;
    expect(summarizeMailBrief(experience)).toBe("No meetings in the mail checked.");
    const partial = parse({ mail_brief: {
      ...brief, requested: ["meetings", "payments_due"], failed: ["payments_due"],
      counts_by_category: { meetings: 0 }, items: [],
    } }) as MailBriefExperience;
    // Negative control: it read "The checks that finished found nothing that needs you", as if every kind was checked.
    expect(summarizeMailBrief(partial)).toBe("No meetings in the mail checked · Couldn't check for payments due");
    const heldMeeting = { ...paidBill, category: "meetings", subject: "Design review" };
    const withDone = parse({
      mail_brief: { ...brief, requested: ["meetings"], counts_by_category: { meetings: 1 }, items: [heldMeeting] },
    }) as MailBriefExperience;
    // Negative control: "No meetings in the mail checked." sat above the meeting's own Done row.
    expect(summarizeMailBrief(withDone)).toBe("No open meetings in the mail checked.");
  });

  it("turns a receipt read the device could not answer into Connect or Open receipts", () => {
    expect(receiptSetupExperience("connect_required")).toEqual({
      type: "one.workspace_connector_setup.v1", provider: "gmail", status: "connect_required",
    });
    const sync = receiptSetupExperience("sync_required");
    render(<MailChatCard experience={sync as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Open receipts" }));
    expect(push).toHaveBeenCalledWith("/one/gmail?workspace=receipts");
  });
});
