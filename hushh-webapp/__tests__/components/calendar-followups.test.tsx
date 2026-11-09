import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CalendarFollowups } from "@/components/calendar/calendar-followups";

const service = vi.hoisted(() => ({
  status: vi.fn(), list: vi.fn(), detail: vi.fn(), source: vi.fn(),
  resolve: vi.fn(), post: vi.fn(), change: vi.fn(),
}));
vi.mock("@/lib/services/calendar-followups-service", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/services/calendar-followups-service")>()),
  CalendarFollowupsService: service,
}));
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
        original_due_wording: "before 26 October", due_date: "2026-10-26", proposed_date: null, ambiguities: [] },
      { id: callId, kind: "meeting", state: "needs_review", title: "Call with Jhumma",
        original_due_wording: "on 27 October", due_date: null, proposed_date: "2026-10-27", ambiguities: ["time", "duration"] },
    ],
  }],
};

function props(accountId: string, onConnectMail: (accountId: string) => Promise<boolean>) {
  return {
    userId: "owner", accountId, accountEmail: `${accountId}@example.test`,
    zone: "Asia/Kolkata", expanded: false,
    getIdToken: async () => "synthetic-id-token", getVaultOwnerToken: () => "synthetic-owner-token",
    onViewAll: vi.fn(), onConnectMail, onReviewMeeting: vi.fn(),
  };
}

describe("Calendar Insights Follow-ups account boundary", () => {
  beforeEach(() => { Object.values(service).forEach(mock => mock.mockReset()); });

  it("keeps B monitoring active while C connects Mail and opts in", async () => {
    let cConnected = false;
    let cEnabled = false;
    service.status.mockImplementation(async (_user, accountId) => ({
      account_id: accountId, mail_connected: accountId === "account_B" || cConnected,
      monitoring_enabled: accountId === "account_B" || cEnabled,
      background_available: true, scan_state: cEnabled || accountId === "account_B" ? "complete" : "off",
      incomplete_source_count: 0, notifications_enabled: false,
      historical_start_at: null, time_zone: "Asia/Kolkata",
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
    expect(screen.getByText(/before 26 October/)).toBeInTheDocument();
    view.rerender(<CalendarFollowups key="account_C" {...props("account_C", onConnectMail)} />);
    expect(await screen.findByText(/Mail is not connected for account_C/)).toBeInTheDocument();
    expect(screen.queryByText("Send the research document")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Mail" }));
    expect(await screen.findByRole("button", { name: "Enable" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remind me"));
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(service.post).toHaveBeenCalledWith("preferences", expect.objectContaining({
      account_id: "account_C", enabled: true, notifications_enabled: true,
    }), "synthetic-id-token", "synthetic-owner-token"));
    await waitFor(() => expect(service.post).toHaveBeenCalledWith("scan", {
      user_id: "owner", account_id: "account_C",
    }, "synthetic-id-token", "synthetic-owner-token"));
    expect(service.post.mock.calls.some(([, body]) => body.account_id === "account_B")).toBe(false);
  });

  it("retains a failed notification link and retries the exact request", async () => {
    window.history.replaceState(null, "", `/one/calendar?followupAccount=account_B&followupRequest=${callId}`);
    service.status.mockResolvedValue({
      account_id: "account_B", mail_connected: true, monitoring_enabled: true,
      background_available: true, scan_state: "complete", incomplete_source_count: 0,
      notifications_enabled: true, historical_start_at: null, time_zone: "Asia/Kolkata",
    });
    service.list.mockResolvedValue(bList);
    service.resolve.mockResolvedValue(conversationId);
    const request = (preview: typeof bList.conversations[0]["preview_requests"][number]) => ({
      ...preview, source_excerpt: "Could we have a call on 27 October", due_relation: null,
      proposed_at: null, time_zone: "Asia/Kolkata", responsibility: "owner",
      reminder_at: null, source_internal_date_ms: Date.parse("2026-10-10T12:00:00Z"),
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
    expect(screen.getByText("Not booked")).toBeInTheDocument();
    expect(document.activeElement?.textContent).toContain("Call with Jhumma");
    window.history.replaceState(null, "", "/one/calendar");
  });

  it("loads a notification target after the vault is unlocked", async () => {
    service.status.mockResolvedValue({
      account_id: "account_B", mail_connected: true, monitoring_enabled: true,
      background_available: true, scan_state: "complete", incomplete_source_count: 0,
      notifications_enabled: true, historical_start_at: null, time_zone: "Asia/Kolkata",
    });
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

  const monitored = {
    account_id: "account_B", mail_connected: true, monitoring_enabled: true,
    background_available: true, scan_state: "complete", incomplete_source_count: 0,
    notifications_enabled: true, historical_start_at: null, time_zone: "Asia/Kolkata",
  };
  const counts = { upcoming: 16, overdue: 2, snoozed: 0, history: 3 };

  it("pages the full view 15 at a time from the server instead of loading more", async () => {
    service.status.mockResolvedValue(monitored);
    const page = (offset: number, nextOffset: number | null, title: string) => ({
      ...bList, view: "upcoming", view_counts: counts, total_conversations: 16, next_offset: nextOffset,
      conversations: [{ ...bList.conversations[0], id: `44444444-4444-4444-8444-44444444444${offset ? 5 : 4}`,
        preview_requests: [{ ...bList.conversations[0].preview_requests[0],
          id: `55555555-5555-4555-8555-55555555555${offset ? 6 : 5}`, title }] }],
    });
    service.list.mockImplementation(async (_u, _a, _t, _o, _s, offset = 0) =>
      offset === 0 ? page(0, 15, "First page item") : page(15, null, "Second page item"));
    render(<CalendarFollowups {...props("account_B", vi.fn())} expanded />);
    expect(await screen.findByText("First page item")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Second page item")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(service.list.mock.calls.at(-1)?.slice(5)).toEqual([15, "upcoming"]);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("First page item")).toBeInTheDocument();
    expect(service.list.mock.calls.at(-1)?.slice(5)).toEqual([0, "upcoming"]);
  });

  it("shows only Upcoming in the compact card and lets the full view switch lists", async () => {
    service.status.mockResolvedValue(monitored);
    const overdue = { ...bList, view: "overdue", view_counts: counts, total_conversations: 2, next_offset: null,
      conversations: [{ ...bList.conversations[0], preview_requests: [{
        ...bList.conversations[0].preview_requests[0], title: "Send the signed agreement",
        original_due_wording: "before 30 October", due_date: "2026-10-30", bucket: "overdue", after_date: "owed" }] }] };
    service.list.mockImplementation(async (_u, _a, _t, _o, _s, _offset = 0, view = "upcoming") =>
      view === "overdue" ? overdue : { ...bList, view, view_counts: counts });
    const compact = render(<CalendarFollowups {...props("account_B", vi.fn())} />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Follow-up lists" })).not.toBeInTheDocument();
    expect(service.list.mock.calls.every(call => call[5] === 0 && call[6] === "upcoming")).toBe(true);
    compact.unmount();
    render(<CalendarFollowups {...props("account_B", vi.fn())} expanded />);
    expect(await screen.findByText("Send the research document")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Snoozed/ })).not.toBeInTheDocument(); // empty lists stay out of the way
    fireEvent.click(screen.getByRole("button", { name: "Overdue · 2" }));
    expect(await screen.findByText("Send the signed agreement")).toBeInTheDocument();
    expect(screen.getByText(/Overdue · was due/)).toBeInTheDocument();
    expect(service.list.mock.calls.at(-1)?.slice(5)).toEqual([0, "overdue"]);
  });
});
