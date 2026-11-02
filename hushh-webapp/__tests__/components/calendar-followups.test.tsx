import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CalendarFollowups } from "@/components/calendar/calendar-followups";
import {
  coverageNotice, dueText, gmailMessageUrl, primaryRequest, reminderText, senderName,
} from "@/lib/calendar/calendar-followup-presentation";

const service = vi.hoisted(() => ({
  status: vi.fn(), list: vi.fn(), detail: vi.fn(), source: vi.fn(), sourceLink: vi.fn(),
  resolve: vi.fn(), post: vi.fn(), change: vi.fn(), scan: vi.fn(),
}));
vi.mock("@/lib/services/calendar-followups-service", () => ({ CalendarFollowupsService: service }));
vi.mock("@/components/app-ui/settings-ui", () => ({
  AdaptiveDetailSurface: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
}));

const conversationId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const callId = "33333333-3333-4333-8333-333333333333";
const bList = {
  account_id: "account_B", scan_state: "complete", incomplete_source_count: 0,
  total_conversations: 1, next_offset: null, conversations: [{
    id: conversationId, subject: "Research document and call", sender: "Jhumma <jhumma@example.test>",
    latest_internal_date_ms: Date.parse("2026-10-10T12:00:00Z"),
    request_count: 2, active_count: 2, source_completeness: "complete",
    preview_requests: [
      { id: documentId, kind: "deadline", state: "pending", title: "Send the research document",
        original_due_wording: "before 26 October", due_date: "2026-10-26", due_relation: "before",
        proposed_date: null, ambiguities: [], urgency: "time_bound", meeting_state: "none" },
      { id: callId, kind: "meeting", state: "needs_review", title: "Review proposed call with Jhumma",
        original_due_wording: "on 27 October", due_date: null, proposed_date: "2026-10-27",
        ambiguities: ["time", "duration"], urgency: "none", meeting_state: "proposed" },
    ],
  }],
};

function status(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    account_id: accountId, mail_connected: true, monitoring_enabled: true, monitor_current: true,
    background_available: true, scan_state: "complete", incomplete_source_count: 0,
    coverage: { coverage: "complete", attention: null, waiting_source_count: 0, exhausted_source_count: 0, unreadable_count: 0 },
    last_complete_at: "2026-10-10T12:00:00Z", notifications_enabled: true,
    reminder_lead_days: 1, reminder_hour: 9, historical_start_at: "2026-09-10T00:00:00Z",
    time_zone: "Asia/Kolkata", ...overrides,
  };
}

function props(accountId: string, onConnectMail: (accountId: string) => Promise<boolean> = vi.fn(async () => true)) {
  return {
    userId: "owner", accountId, accountEmail: `${accountId}@example.test`,
    zone: "Asia/Kolkata", expanded: false,
    getIdToken: async () => "synthetic-id-token", getVaultOwnerToken: () => "synthetic-owner-token",
    onViewAll: vi.fn(), onConnectMail, onReviewMeeting: vi.fn(),
  };
}

describe("Follow-ups wording", () => {
  const document = bList.conversations[0]!.preview_requests[0]!;
  const call = bList.conversations[0]!.preview_requests[1]!;

  it("states verified dates plainly and never invents one", () => {
    expect(dueText(document as never)).toMatch(/^Due before .*26/);
    expect(dueText(call as never)).toMatch(/27 · Time to confirm$/);
    // No verified date: say so, even when the sender stressed urgency.
    expect(dueText({ ...document, due_date: null, due_relation: null, urgency: "asap" } as never)).toBe("Urgent · No date given");
    expect(dueText({ ...document, due_date: null, due_relation: null, urgency: "none" } as never)).toBe("No date given");
  });

  it("puts the earliest verified date first, then explicit urgency", () => {
    const entry = { preview_requests: [
      { ...document, id: "a", due_date: null, urgency: "asap" },
      { ...document, id: "b", due_date: "2026-11-05" },
      { ...document, id: "c", due_date: "2026-10-26" },
    ] };
    expect(primaryRequest(entry as never)?.id).toBe("c");
    expect(primaryRequest({ preview_requests: entry.preview_requests.slice(0, 1) } as never)?.id).toBe("a");
  });

  it("names the sender, links the exact Gmail message and states reminders honestly", () => {
    expect(senderName('"IIT Professor" <prof@iit.example>')).toBe("IIT Professor");
    expect(senderName("prof@iit.example")).toBe("prof");
    expect(gmailMessageUrl("owner@example.test", "18c0ffee")).toBe("https://mail.google.com/mail/u/owner%40example.test/#all/18c0ffee");
    const request = { ...document, state: "pending", reminder_at: null, reminder_status: "none", source_excerpt: "", time_zone: null, responsibility: "owner", source_internal_date_ms: 0, revision: 1, booking_state: null };
    expect(reminderText(request as never, "Asia/Kolkata")).toBe("No reminder set");
    expect(reminderText({ ...request, due_date: null } as never, "Asia/Kolkata")).toBe("No reminder · no date in the email");
    expect(reminderText({ ...request, state: "done" } as never, "Asia/Kolkata")).toBe("Completed");
  });

  it("is quiet while recoverable and speaks only when the owner must act", () => {
    const base = { waiting_source_count: 0, exhausted_source_count: 0, unreadable_count: 0 };
    expect(coverageNotice({ coverage: "complete", attention: null, ...base })).toBeNull();
    expect(coverageNotice({ coverage: "catching_up", attention: null, ...base })).toEqual({ tone: "quiet", text: "Catching up on your email…", action: null });
    expect(coverageNotice({ coverage: "needs_attention", attention: "reconnect_mail", ...base })?.action).toBe("reconnect");
    expect(coverageNotice({ coverage: "needs_attention", attention: "retry_needed", ...base })?.action).toBe("retry");
  });
});

describe("Calendar Insights Follow-ups card", () => {
  beforeEach(() => {
    Object.values(service).forEach(mock => mock.mockReset());
    service.scan.mockResolvedValue(undefined);
    service.sourceLink.mockImplementation(async (_user, accountId, requestId) => ({
      request_id: requestId, account_id: accountId, gmail_message_id: "18c0ffee",
    }));
    window.localStorage.clear();
  });

  it("keeps B monitoring active while C allows email access in one step", async () => {
    let cConnected = false;
    let cEnabled = false;
    service.status.mockImplementation(async (_user, accountId) => accountId === "account_B"
      ? status("account_B")
      : status("account_C", {
        mail_connected: cConnected, monitoring_enabled: cEnabled, monitor_current: cEnabled,
        scan_state: cEnabled ? "complete" : "off", coverage: null, notifications_enabled: false,
        historical_start_at: null, time_zone: null,
      }));
    service.list.mockImplementation(async (_user, accountId) => accountId === "account_B"
      ? bList : { account_id: "account_C", scan_state: "complete", incomplete_source_count: 0,
          total_conversations: 0, conversations: [] });
    service.post.mockImplementation(async (path, body) => {
      if (path === "preferences" && body.account_id === "account_C") cEnabled = body.enabled;
      return { account_id: body.account_id };
    });
    const onConnectMail = vi.fn(async (accountId: string) => {
      expect(accountId).toBe("account_C"); cConnected = true; return true;
    });
    const view = render(<CalendarFollowups key="account_B" {...props("account_B", onConnectMail)} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    // B's own background catch-up on open is expected; C's flow must add nothing to it.
    await waitFor(() => expect(service.scan).toHaveBeenCalledTimes(1));
    service.scan.mockClear(); service.post.mockClear();
    view.rerender(<CalendarFollowups key="account_C" {...props("account_C", onConnectMail)} />);
    expect(await screen.findByText("Find meeting requests and reminders in my email.")).toBeInTheDocument();
    expect(screen.getByText(/one extra permission to read account_C@example.test/)).toBeInTheDocument();
    expect(screen.queryByText("Send the research document")).not.toBeInTheDocument();
    // One action both asks for Mail and turns monitoring on: no second "Enable" step.
    fireEvent.click(screen.getByRole("button", { name: "Allow email access" }));
    await waitFor(() => expect(service.post).toHaveBeenCalledWith("preferences", expect.objectContaining({
      account_id: "account_C", enabled: true, notifications_enabled: true,
    }), "synthetic-id-token", "synthetic-owner-token"));
    await waitFor(() => expect(service.scan).toHaveBeenCalledWith(
      "owner", "account_C", "synthetic-id-token", "synthetic-owner-token"));
    expect(onConnectMail).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Allow email access" })).not.toBeInTheDocument();
    expect(service.post.mock.calls.some(([, body]) => body.account_id === "account_B")).toBe(false);
    expect(service.scan.mock.calls.some(call => call[1] === "account_B")).toBe(false);
  });

  it("does not ask for Mail again once access exists", async () => {
    service.status.mockResolvedValue(status("account_granted", { monitoring_enabled: false, monitor_current: false, scan_state: "off", coverage: null }));
    const onConnectMail = vi.fn(async () => true);
    service.post.mockResolvedValue({ account_id: "account_granted" });
    render(<CalendarFollowups {...props("account_granted", onConnectMail)} />);
    expect(await screen.findByText(/already has read access to account_granted@example.test/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect Mail|Allow email access/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(service.post).toHaveBeenCalledWith("preferences", expect.objectContaining({ enabled: true }), expect.anything(), expect.anything()));
    expect(onConnectMail).not.toHaveBeenCalled();
  });

  it("shows at most two short previews with one Review action each", async () => {
    const entry = (index: number) => ({
      ...bList.conversations[0], id: `00000000-0000-4000-8000-00000000000${index}`,
      sender: "Prof <prof@iit.example>", subject: `Thread ${index}`,
      preview_requests: [{ ...bList.conversations[0]!.preview_requests[0], id: `99999999-9999-4999-8999-99999999999${index}`, title: `Send document ${index}` }],
      request_count: 1, active_count: 1,
    });
    service.status.mockResolvedValue(status("account_previews"));
    service.list.mockResolvedValue({ ...bList, account_id: "account_previews", total_conversations: 3, conversations: [entry(1), entry(2), entry(3)] });
    render(<CalendarFollowups {...props("account_previews")} />);
    expect(await screen.findByText("Send document 1")).toBeInTheDocument();
    expect(screen.getByText("Send document 2")).toBeInTheDocument();
    expect(screen.queryByText("Send document 3")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Review / })).toHaveLength(2);
    expect(screen.getAllByText(/From Prof$/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();
  });

  it("groups one email's actions into a single row", async () => {
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    render(<CalendarFollowups {...props("account_B")} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.getByText("1 more in this email")).toBeInTheDocument();
    expect(screen.getByText(/Due before .*26 · From Jhumma/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Review / })).toHaveLength(1);
  });

  it("is quiet while catching up and never shows the old orange warning", async () => {
    service.status.mockResolvedValue(status("account_quiet", {
      scan_state: "partial", incomplete_source_count: 2,
      coverage: { coverage: "catching_up", attention: null, waiting_source_count: 2, exhausted_source_count: 0, unreadable_count: 0 },
    }));
    service.list.mockResolvedValue({ ...bList, account_id: "account_quiet", scan_state: "partial", incomplete_source_count: 2 });
    render(<CalendarFollowups {...props("account_quiet")} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.getByText("Catching up on your email…")).toBeInTheDocument();
    expect(screen.queryByText(/could not be checked completely/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it("asks the owner to act only when retrying cannot fix it, and Check again forces a retry", async () => {
    service.status.mockResolvedValue(status("account_stuck", {
      scan_state: "partial", incomplete_source_count: 1,
      coverage: { coverage: "needs_attention", attention: "retry_needed", waiting_source_count: 0, exhausted_source_count: 1, unreadable_count: 0 },
    }));
    service.list.mockResolvedValue({ ...bList, account_id: "account_stuck" });
    render(<CalendarFollowups {...props("account_stuck")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(service.scan).toHaveBeenCalledWith(
      "owner", "account_stuck", "synthetic-id-token", "synthetic-owner-token", { retry: true }));
  });

  it("continues in the background once and not again on reopening", async () => {
    service.status.mockResolvedValue(status("account_catchup"));
    service.list.mockResolvedValue({ ...bList, account_id: "account_catchup" });
    const first = render(<CalendarFollowups {...props("account_catchup")} />);
    // Verified items appear without waiting for the catch-up scan.
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    await waitFor(() => expect(service.scan).toHaveBeenCalledTimes(1));
    expect(service.scan.mock.calls[0]).toEqual(["owner", "account_catchup", "synthetic-id-token", "synthetic-owner-token", {}, expect.anything()]);
    first.unmount();
    render(<CalendarFollowups {...props("account_catchup")} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(service.scan).toHaveBeenCalledTimes(1);
  });

  it("rebinds a renewed Mail grant silently, keeping the approved period", async () => {
    service.status.mockResolvedValue(status("account_renewed", { monitor_current: false }));
    service.list.mockResolvedValue({ ...bList, account_id: "account_renewed" });
    service.post.mockResolvedValue({ account_id: "account_renewed" });
    const onConnectMail = vi.fn(async () => true);
    render(<CalendarFollowups {...props("account_renewed", onConnectMail)} />);
    await waitFor(() => expect(service.post).toHaveBeenCalledWith("preferences", expect.objectContaining({
      account_id: "account_renewed", enabled: true, historical_start_at: "2026-09-10T00:00:00Z",
      notifications_enabled: true, reminder_lead_days: 1, reminder_hour: 9,
    }), "synthetic-id-token", "synthetic-owner-token", expect.anything()));
    expect(onConnectMail).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Allow email access|Turn on/ })).not.toBeInTheDocument();
    expect(service.post).toHaveBeenCalledTimes(1);
  });

  it("retains a failed notification link and retries the exact request", async () => {
    window.history.replaceState(null, "", `/one/calendar?followupAccount=account_B&followupRequest=${callId}`);
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    service.resolve.mockResolvedValue(conversationId);
    const request = (preview: typeof bList.conversations[0]["preview_requests"][number]) => ({
      ...preview, source_excerpt: "Could we have a call on 27 October", due_relation: null,
      proposed_at: null, time_zone: "Asia/Kolkata", responsibility: "owner",
      reminder_at: null, reminder_status: "none", linked_event: null,
      source_internal_date_ms: Date.parse("2026-10-10T12:00:00Z"),
      revision: 1, booking_state: preview.kind === "meeting" ? "not_booked" : null,
    });
    service.detail.mockRejectedValueOnce(new Error("transient")).mockResolvedValue({
      ...bList.conversations[0], account_id: "account_B",
      requests: bList.conversations[0].preview_requests.map(request),
    });
    const handled = vi.fn();
    render(<CalendarFollowups {...props("account_B", vi.fn())} deepLinkRequestId={callId} onDeepLinkHandled={handled} />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("Follow-ups could not be checked. Try again.")).toBeInTheDocument();
    expect(window.location.search).toContain(callId);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(handled).toHaveBeenCalledOnce());
    expect(window.location.search).not.toContain("followupRequest");
    // Two requests from one email link that email once, not once per request.
    expect(screen.getAllByRole("link", { name: /Open original email/ })).toHaveLength(1);
    // A proposed meeting is never described as scheduled.
    expect(screen.getByText(/Meeting proposed · .*27 · Time to confirm · Not on your Calendar yet/)).toBeInTheDocument();
    expect(screen.queryByText(/scheduled/i)).not.toBeInTheDocument();
    expect(document.activeElement?.textContent).toContain("Review proposed call with Jhumma");
    window.history.replaceState(null, "", "/one/calendar");
  });

  it("opens the exact original email and shows only a brief sanitized excerpt", async () => {
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    service.detail.mockResolvedValue({
      ...bList.conversations[0], account_id: "account_B",
      requests: [{
        ...bList.conversations[0]!.preview_requests[0], source_excerpt: "Please send the signed document before 26 October.",
        proposed_at: null, time_zone: null, responsibility: "owner", reminder_at: null, reminder_status: "none",
        linked_event: ["evt-sync", "Hushh Growth Sync", "2026-10-27T23:00:00+05:30"],
        source_internal_date_ms: Date.parse("2026-10-10T12:00:00Z"), revision: 1, booking_state: null,
      }],
    });
    render(<CalendarFollowups {...props("account_B")} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Review / }));
    const link = await screen.findByRole("link", { name: /Open original email/ });
    expect(link).toHaveAttribute("href", "https://mail.google.com/mail/u/account_B%40example.test/#all/18c0ffee");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Please send the signed document/)).toBeInTheDocument();
    // An email that is about a meeting already on Calendar points at it.
    expect(screen.getByText(/About: Hushh Growth Sync/)).toBeInTheDocument();
    expect(screen.getByText("No reminder set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snooze 1 day" })).toBeInTheDocument();
  });

  it("loads a notification target after the vault is unlocked", async () => {
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    service.resolve.mockResolvedValue(conversationId);
    service.detail.mockResolvedValue({
      ...bList.conversations[0], account_id: "account_B", requests: [],
    });
    let token: string | null = null;
    const base = props("account_B", vi.fn());
    const view = render(<CalendarFollowups {...base} getVaultOwnerToken={() => token} deepLinkRequestId={documentId} />);
    expect(await screen.findByText("Unlock One to view follow-ups.")).toBeInTheDocument();
    expect(service.list).not.toHaveBeenCalled();
    token = "synthetic-owner-token";
    view.rerender(<CalendarFollowups {...base} getVaultOwnerToken={() => token} deepLinkRequestId={documentId} />);
    await waitFor(() => expect(service.resolve).toHaveBeenCalledWith(
      "owner", "account_B", documentId, "synthetic-id-token", token, expect.anything(),
    ));
  });

  it("loads additional conversations from View all", async () => {
    service.status.mockResolvedValue(status("account_B"));
    const first = { ...bList, total_conversations: 2, next_offset: 1 };
    const second = { ...bList, total_conversations: 2, next_offset: null,
      conversations: [{ ...bList.conversations[0], id: "44444444-4444-4444-8444-444444444444",
        preview_requests: [{ ...bList.conversations[0].preview_requests[0],
          id: "55555555-5555-4555-8555-555555555555", title: "Another document" }] }] };
    service.list.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    render(<CalendarFollowups {...props("account_B", vi.fn())} expanded />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Another document")).toBeInTheDocument();
    expect(service.list.mock.calls[1]?.[5]).toBe(1);
  });
});
