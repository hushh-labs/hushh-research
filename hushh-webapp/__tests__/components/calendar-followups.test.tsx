import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarFollowups } from "@/components/calendar/calendar-followups";
import {
  coverageNotice, dueText, followupErrorText, gmailMessageUrl, primaryRequest, reminderText, rowSummary,
} from "@/lib/calendar/calendar-followup-presentation";
import { scanWhilePending } from "@/lib/calendar/calendar-followup-sync";

const service = vi.hoisted(() => ({
  status: vi.fn(), list: vi.fn(), detail: vi.fn(), source: vi.fn(), sourceLink: vi.fn(),
  resolve: vi.fn(), post: vi.fn(), change: vi.fn(), scan: vi.fn(),
}));
vi.mock("@/lib/services/calendar-followups-service", () => ({ CalendarFollowupsService: service }));
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
  it("keeps the unlock instruction and hides nothing else behind a generic failure", () => {
    expect(followupErrorText(new Error("Unlock One to check your email again."))).toBe("Unlock One to check your email again.");
    expect(followupErrorText(new Error("FOLLOWUPS_DISABLED"))).toBe("Follow-ups are not available yet. Try again later.");
    expect(followupErrorText(new Error("mail_grant_changed"))).toBe("Follow-ups could not be checked. Try again.");
    expect(coverageNotice({ coverage: "needs_attention", attention: "reconnect_mail", waiting_source_count: 0, exhausted_source_count: 0, unreadable_count: 0 }, false))
      .toEqual({ tone: "quiet", text: "Unlock One to check your email.", action: null });
  });

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

  it("shows date status without repeating the action or sender", () => {
    const request = { ...document, due_date: null, urgency: "none", category: "document_or_information" };
    expect(rowSummary({ ...bList.conversations[0], preview_requests: [request] } as never).detail)
      .toBe("No date given · +1 more");
  });

  it("links the exact Gmail message and states reminders honestly", () => {
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
    expect(coverageNotice({ coverage: "needs_attention", attention: "retry_needed", ...base })).toBeNull();
    expect(coverageNotice({ coverage: "needs_attention", attention: "provider_unavailable", ...base })).toBeNull();
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
    expect(await screen.findByText("Find Calendar follow-ups in email.")).toBeInTheDocument();
    expect(screen.getByText(/check account_C@example.test/)).toBeInTheDocument();
    expect(screen.queryByText("Send the research document")).not.toBeInTheDocument();
    // There is no look-back choice: a first scan is always the most recent 30 days.
    expect(screen.queryByText(/Look back/)).not.toBeInTheDocument();
    // One action both asks for Mail and turns monitoring on: no second "Enable" step.
    fireEvent.click(screen.getByRole("button", { name: "Allow email access" }));
    await waitFor(() => expect(service.post).toHaveBeenCalledWith("preferences", expect.objectContaining({
      account_id: "account_C", enabled: true, notifications_enabled: true,
    }), "synthetic-id-token", "synthetic-owner-token"));
    await waitFor(() => expect(service.scan).toHaveBeenCalledWith(
      "owner", "account_C", "synthetic-id-token", "synthetic-owner-token"));
    expect(onConnectMail).toHaveBeenCalledOnce();
    const approved = service.post.mock.calls.find(([path]) => path === "preferences")![1];
    expect(Math.round((Date.now() - Date.parse(approved.historical_start_at)) / 86_400_000)).toBe(30);
    expect(screen.queryByRole("button", { name: "Allow email access" })).not.toBeInTheDocument();
    expect(service.post.mock.calls.some(([, body]) => body.account_id === "account_B")).toBe(false);
    expect(service.scan.mock.calls.some(call => call[1] === "account_B")).toBe(false);
  });

  it("does not ask for Mail again once access exists", async () => {
    service.status.mockResolvedValue(status("account_granted", { monitoring_enabled: false, monitor_current: false, scan_state: "off", coverage: null }));
    const onConnectMail = vi.fn(async () => true);
    service.post.mockResolvedValue({ account_id: "account_granted" });
    render(<CalendarFollowups {...props("account_granted", onConnectMail)} />);
    expect(await screen.findByText(/last 30 days of account_granted@example.test/)).toBeInTheDocument();
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
    expect(screen.queryByText(/From Prof$/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();
  });

  it("groups one email's actions into a single row", async () => {
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    render(<CalendarFollowups {...props("account_B")} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.getByText(/Due before .*26 · \+1 more/)).toBeInTheDocument();
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

  it("says the email is synced once when the check finishes, not on every load", async () => {
    service.status.mockResolvedValue(status("account_synced", {
      scan_state: "partial",
      coverage: { coverage: "catching_up", attention: null, waiting_source_count: 1, exhausted_source_count: 0, unreadable_count: 0 },
    }));
    service.list.mockResolvedValue({ ...bList, account_id: "account_synced" });
    const view = render(<CalendarFollowups {...props("account_synced")} />);
    expect(await screen.findByText("Catching up on your email…")).toBeInTheDocument();
    expect(screen.queryByText("Your email is synced.")).not.toBeInTheDocument();
    view.unmount();
    service.status.mockResolvedValue(status("account_synced"));
    const finished = render(<CalendarFollowups {...props("account_synced")} />);
    expect(await screen.findByText("Your email is synced.")).toBeInTheDocument();
    finished.unmount();
    render(<CalendarFollowups {...props("account_synced")} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.queryByText("Your email is synced.")).not.toBeInTheDocument();
  });

  it("has no settings menu and keeps the last verified list when a reload fails", async () => {
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    const view = render(<CalendarFollowups {...props("account_B")} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow-up settings" })).not.toBeInTheDocument();
    service.list.mockRejectedValue(new Error("FOLLOWUPS_UNAVAILABLE"));
    view.rerender(<CalendarFollowups {...props("account_B")} refreshRevision={1} />);
    await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Send the research document")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps verified follow-ups visible and retries quietly when email coverage is partial", async () => {
    service.status.mockResolvedValue(status("account_stuck", {
      scan_state: "partial", incomplete_source_count: 1,
      coverage: { coverage: "needs_attention", attention: "retry_needed", waiting_source_count: 0, exhausted_source_count: 1, unreadable_count: 0 },
    }));
    service.list.mockResolvedValue({ ...bList, account_id: "account_stuck" });
    render(<CalendarFollowups {...props("account_stuck")} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.queryByText("A few emails could not be read yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    await waitFor(() => expect(service.scan).toHaveBeenCalledWith(
      "owner", "account_stuck", "synthetic-id-token", "synthetic-owner-token", {}, expect.any(AbortSignal)));
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

  it("turns reminders on for a monitored account that had them off, without asking", async () => {
    service.status.mockResolvedValue(status("account_quiet_off", { notifications_enabled: false }));
    service.list.mockResolvedValue({ ...bList, account_id: "account_quiet_off" });
    service.post.mockResolvedValue({ account_id: "account_quiet_off" });
    render(<CalendarFollowups {...props("account_quiet_off")} />);
    await waitFor(() => expect(service.post).toHaveBeenCalledWith("preferences", expect.objectContaining({
      account_id: "account_quiet_off", enabled: true, notifications_enabled: true,
      historical_start_at: "2026-09-10T00:00:00Z",
    }), "synthetic-id-token", "synthetic-owner-token", expect.anything()));
    expect(screen.queryByText(/Remind me/)).not.toBeInTheDocument();
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

  it("retains a failed notification link and retries the resolved request", async () => {
    const mergedId = "44444444-4444-4444-8444-444444444444";
    window.history.replaceState(null, "", `/one/calendar?followupAccount=account_B&followupRequest=${mergedId}`);
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    service.resolve.mockResolvedValue({ conversationId, requestId: callId });
    const request = (preview: typeof bList.conversations[0]["preview_requests"][number]) => ({
      ...preview, source_excerpt: "Could we have a call on 27 October", due_relation: null,
      proposed_at: null, time_zone: "Asia/Kolkata", responsibility: "owner",
      reminder_at: preview.kind === "meeting" ? "2026-10-26T03:30:00Z" : null,
      reminder_status: preview.kind === "meeting" ? "scheduled" : "none", linked_event: null,
      source_internal_date_ms: Date.parse("2026-10-10T12:00:00Z"),
      revision: 1, booking_state: preview.kind === "meeting" ? "not_booked" : null,
    });
    service.detail.mockRejectedValueOnce(new Error("transient")).mockResolvedValue({
      ...bList.conversations[0], account_id: "account_B",
      requests: bList.conversations[0].preview_requests.map(request),
    });
    const handled = vi.fn();
    render(<CalendarFollowups {...props("account_B", vi.fn())} deepLinkRequestId={mergedId} onDeepLinkHandled={handled} />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("Follow-ups could not be checked. Try again.")).toBeInTheDocument();
    expect(window.location.search).toContain(mergedId);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(handled).toHaveBeenCalledOnce());
    expect(window.location.search).not.toContain("followupRequest");
    // Two requests from one email link that email once, not once per request.
    expect(await screen.findAllByRole("link", { name: /Open original email/ })).toHaveLength(1);
    // A proposed meeting is never described as scheduled.
    expect(screen.getByText(/Meeting proposed · .*27 · Time to confirm · Not on your Calendar yet/)).toBeInTheDocument();
    expect(screen.queryByText(/scheduled/i)).not.toBeInTheDocument();
    // The reminder reaches the call too, and the way to book it is one clear action.
    expect(screen.getByText(/^Reminder .*26/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument();
    expect(document.activeElement?.textContent).toContain("Review proposed call with Jhumma");
    window.history.replaceState(null, "", "/one/calendar");
  });

  it("links the original email and reviews the Calendar action without mail content", async () => {
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
    expect(screen.queryByText(/Please send the signed document/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Research document and call|View email text/)).not.toBeInTheDocument();
    expect(service.source).not.toHaveBeenCalled();
    // An email that is about a meeting already on Calendar points at it.
    expect(screen.getByText(/Hushh Growth Sync/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reminder", exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snooze 1 day" })).not.toBeInTheDocument();
  });

  it("loads a notification target after the vault is unlocked", async () => {
    service.status.mockResolvedValue(status("account_B"));
    service.list.mockResolvedValue(bList);
    service.resolve.mockResolvedValue({ conversationId, requestId: documentId });
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

  it("shows one 15-conversation page at a time with server offsets", async () => {
    service.status.mockResolvedValue(status("account_page", { coverage: {
      coverage: "needs_attention", attention: "reconnect_mail", waiting_source_count: 0,
      exhausted_source_count: 0, unreadable_count: 0,
    } }));
    const conversations = Array.from({ length: 16 }, (_, index) => ({
      ...bList.conversations[0], id: `conversation-${index + 1}`,
      preview_requests: [{ ...bList.conversations[0].preview_requests[0],
        id: `request-${index + 1}`, title: `Send document ${index + 1}` }],
    }));
    const first = { ...bList, account_id: "account_page", total_conversations: 16,
      next_offset: 15, conversations: conversations.slice(0, 15) };
    const second = { ...first, next_offset: null, conversations: conversations.slice(15) };
    service.list.mockImplementation(async (_user, _account, _id, _owner, _signal, offset = 0) => offset === 15 ? second : first);
    render(<CalendarFollowups {...props("account_page", vi.fn())} expanded />);
    expect(await screen.findByText("Send document 1")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    expect(await screen.findByText("Send document 16")).toBeInTheDocument();
    expect(screen.queryByText("Send document 1")).toBeNull();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(service.list.mock.calls.some(call => call[5] === 15)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Go to previous page" }));
    expect(await screen.findByText("Send document 1")).toBeInTheDocument();
    expect(screen.queryByText("Send document 16")).toBeNull();
  });

  it("opens Overdue at offset zero and restores Upcoming on collapse", async () => {
    const account = "account_followup_views";
    service.status.mockResolvedValue(status(account));
    const view_counts = { upcoming: 1, overdue: 1, snoozed: 0, history: 0 };
    const upcoming = { ...bList, account_id: account, view: "upcoming", view_counts };
    const [entry] = bList.conversations;
    const overdue = { ...upcoming, view: "overdue", conversations: [{
      ...entry, preview_requests: [{ ...entry.preview_requests[0], title: "Overdue document", bucket: "overdue" }],
    }] };
    service.list.mockImplementation(async (_user, _account, _id, _owner, _signal, _offset, view) =>
      view === "overdue" ? overdue : upcoming);
    const base = props(account);
    const screenView = render(<CalendarFollowups {...base} />);
    expect(await screen.findByRole("button", { name: "View all" })).toBeInTheDocument();
    screenView.rerender(<CalendarFollowups {...base} expanded />);
    fireEvent.click(screen.getByRole("button", { name: "Overdue (1)" }));
    expect(await screen.findByText("Overdue document")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overdue (1)" })).toHaveAttribute("aria-pressed", "true");
    expect(service.list.mock.calls.some(call => call[5] === 0 && call[6] === "overdue")).toBe(true);
    screenView.rerender(<CalendarFollowups {...base} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.queryByText("Overdue document")).not.toBeInTheDocument();
  });

  it("re-enables pagination when a background refresh supersedes a pending page", async () => {
    service.status.mockResolvedValue(status("account_page", { coverage: {
      coverage: "needs_attention", attention: "reconnect_mail", waiting_source_count: 0,
      exhausted_source_count: 0, unreadable_count: 0,
    } }));
    const first = { ...bList, total_conversations: 16, next_offset: 15 };
    const second = { ...first, next_offset: null, conversations: [{
      ...bList.conversations[0], id: "last", preview_requests: [{
        ...bList.conversations[0].preview_requests[0], title: "Send document 16",
      }],
    }] };
    let resolvePage: (page: typeof second) => void = () => {};
    service.list.mockImplementation(async (_user, _account, _id, _owner, _signal, offset = 0) =>
      offset === 15 ? new Promise<typeof second>(resolve => { resolvePage = resolve; }) : first);
    const base = props("account_page");
    const view = render(<CalendarFollowups {...base} expanded refreshRevision={0} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Go to next page" })).toBeDisabled());
    view.rerender(<CalendarFollowups {...base} expanded refreshRevision={1} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Go to next page" })).toBeEnabled());
    resolvePage(second);
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    expect(screen.queryByText("Send document 16")).toBeNull();
  });

  it("keeps the compact card on its first page when collapsing during Next", async () => {
    service.status.mockResolvedValue(status("account_page", { coverage: {
      coverage: "needs_attention", attention: "reconnect_mail", waiting_source_count: 0,
      exhausted_source_count: 0, unreadable_count: 0,
    } }));
    const first = { ...bList, total_conversations: 16, next_offset: 15 };
    const second = { ...first, next_offset: null, conversations: [{
      ...bList.conversations[0], id: "last", preview_requests: [{
        ...bList.conversations[0].preview_requests[0], title: "Send document 16",
      }],
    }] };
    let resolvePage: (page: typeof second) => void = () => {};
    service.list.mockImplementation(async (_user, _account, _id, _owner, _signal, offset = 0) =>
      offset === 15 ? new Promise<typeof second>(resolve => { resolvePage = resolve; }) : first);
    const base = props("account_page");
    const view = render(<CalendarFollowups {...base} expanded />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    view.rerender(<CalendarFollowups {...base} expanded={false} />);
    resolvePage(second);
    await waitFor(() => expect(screen.getByText("Send the research document")).toBeInTheDocument());
    expect(screen.queryByText("Send document 16")).toBeNull();
  });

  it("reconnecting Mail re-points the monitor even after a background rebind failed", async () => {
    // A transient failure used to latch the rebind off for the life of the card,
    // so "Reconnect email" kept asking again without ever fixing anything.
    let current = false;
    let attempts = 0;
    service.status.mockImplementation(async () => status("account_stale", current
      ? {} : { monitor_current: false, scan_state: "partial", coverage: {
        coverage: "needs_attention", attention: "reconnect_mail", waiting_source_count: 0,
        exhausted_source_count: 0, unreadable_count: 0 } }));
    service.list.mockResolvedValue({ ...bList, account_id: "account_stale" });
    service.post.mockImplementation(async (path) => {
      if (path === "preferences") { attempts += 1; if (attempts === 1) throw new Error("transient"); current = true; }
      return {};
    });
    const onConnectMail = vi.fn(async () => true);
    render(<CalendarFollowups {...props("account_stale", onConnectMail)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect email" }));
    await waitFor(() => expect(service.scan).toHaveBeenCalledWith(
      "owner", "account_stale", "synthetic-id-token", "synthetic-owner-token", { retry: true }));
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(onConnectMail).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reconnect email" })).not.toBeInTheDocument());
    expect(screen.queryByText("Follow-ups could not be checked. Try again.")).not.toBeInTheDocument();
  });

  it("keeps scanning while the server reports more work, then stops", async () => {
    service.status.mockResolvedValue(status("account_more"));
    service.list.mockResolvedValue({ ...bList, account_id: "account_more" });
    service.scan.mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValue({ state: "complete" });
    render(<CalendarFollowups {...props("account_more")} />);
    await waitFor(() => expect(service.scan).toHaveBeenCalledTimes(3));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(service.scan).toHaveBeenCalledTimes(3);
  });

  it("never scans without end when the server always reports more work", async () => {
    service.status.mockResolvedValue(status("account_endless"));
    service.list.mockResolvedValue({ ...bList, account_id: "account_endless" });
    service.scan.mockResolvedValue({ state: "pending" });
    render(<CalendarFollowups {...props("account_endless")} />);
    await waitFor(() => expect(service.scan).toHaveBeenCalledTimes(20));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(service.scan).toHaveBeenCalledTimes(20);
  });

  it("says to unlock One instead of offering a Mail reconnect that cannot help", async () => {
    // UAT: with the vault locked the card never listed or scanned, yet showed
    // "Reconnect email" and a generic failure, sending the owner through Google twice.
    service.status.mockResolvedValue(status("account_locked", {
      monitor_current: false, scan_state: "partial", coverage: {
        coverage: "needs_attention", attention: "reconnect_mail", waiting_source_count: 0,
        exhausted_source_count: 0, unreadable_count: 0 } }));
    render(<CalendarFollowups {...props("account_locked")} getVaultOwnerToken={() => null} />);
    expect(await screen.findByText("Unlock One to check your email.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect email" })).not.toBeInTheDocument();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.scan).not.toHaveBeenCalled();
  });

  it("checks the vault before opening Google consent and names the real problem", async () => {
    service.status.mockResolvedValue(status("account_new", {
      mail_connected: false, monitoring_enabled: false, monitor_current: false, scan_state: "off", coverage: null }));
    const onConnectMail = vi.fn(async () => true);
    render(<CalendarFollowups {...props("account_new", onConnectMail)} getVaultOwnerToken={() => null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow email access" }));
    expect(await screen.findByText("Unlock One before turning on email follow-ups.")).toBeInTheDocument();
    expect(screen.queryByText("Follow-ups could not be checked. Try again.")).not.toBeInTheDocument();
    expect(onConnectMail).not.toHaveBeenCalled();
  });
});

describe("Follow-ups catch-up loop", () => {
  const run = (refresh = vi.fn(async () => undefined)) => scanWhilePending({
    userId: "owner", accountId: "account_B", ownerToken: "synthetic-owner-token", maxCalls: 10,
    getIdToken: async () => "synthetic-id-token", refresh,
  });

  beforeEach(() => { service.scan.mockReset(); });

  it("survives one failed call and keeps scanning until the server is done", async () => {
    service.scan.mockRejectedValueOnce(new Error("FOLLOWUPS_UNAVAILABLE"))
      .mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "complete" });
    const refresh = vi.fn(async () => undefined);
    await expect(run(refresh)).resolves.toBe(true);
    expect(service.scan).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
