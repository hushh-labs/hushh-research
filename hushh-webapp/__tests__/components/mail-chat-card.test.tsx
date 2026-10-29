import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push }) }));

import { MailChatCard, summarizeMailBrief } from "@/components/agent/mail-chat-card";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";
import {
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

function parse(result: unknown) {
  return parseAgentToolResultExperience("ask_email_agent", result);
}

afterEach(cleanup);

describe("Mail brief in chat", () => {
  it("parses the specialist's brief from the ask_email_agent result and keeps the receipt otherwise", () => {
    const experience = parse({ status: "ok", mail_brief: brief, structured: {} });
    expect(experience?.type).toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
    // Negative controls: an unknown category or a broken count never renders a brief.
    expect(parse({ mail_brief: { ...brief, counts_by_category: { blockers: 1 } } })?.type).not.toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
    expect(parse({ mail_brief: { ...brief, counts_by_category: { action_items: -1 } } })?.type).not.toBe(MAIL_BRIEF_EXPERIENCE_TYPE);
  });

  it("shows counts, the open item first, and every item behind Show all until Back", () => {
    const experience = parse({ mail_brief: brief }) as MailBriefExperience;
    expect(summarizeMailBrief(experience)).toBe("2 need you · 1 payment due");
    render(<MailChatCard experience={experience} />);
    expect(screen.getByText("Sign the lease")).toBeTruthy();
    expect(screen.queryByText("Old request")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show all 3/ }));
    expect(screen.getAllByTestId("mail-brief-item")).toHaveLength(3);
    expect(screen.getByText("Only recent mail was checked.")).toBeTruthy();
    act(() => { expect(unwindBackLayer("/")).toBe(true); });
    expect(screen.getAllByTestId("mail-brief-item")).toHaveLength(1);
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
