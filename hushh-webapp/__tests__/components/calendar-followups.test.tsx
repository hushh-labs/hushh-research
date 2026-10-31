import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CalendarFollowups } from "@/components/calendar/calendar-followups";

const service = vi.hoisted(() => ({
  status: vi.fn(), list: vi.fn(), detail: vi.fn(), source: vi.fn(),
  resolve: vi.fn(), post: vi.fn(), change: vi.fn(),
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

  it("loads additional conversations from View all", async () => {
    service.status.mockResolvedValue({
      account_id: "account_B", mail_connected: true, monitoring_enabled: true,
      background_available: true, scan_state: "complete", incomplete_source_count: 0,
      notifications_enabled: true, historical_start_at: null, time_zone: "Asia/Kolkata",
    });
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
