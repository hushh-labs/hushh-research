import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mock.apiFetch } }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: "synthetic-owner" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { CalendarInvitations } from "@/components/calendar/calendar-invitations";
import { CacheService } from "@/lib/services/cache-service";

const photo = "data:image/png;base64,aGVsbG8=";
const event = {
  id: "meeting", calendar_id: "work@example.test", title: "Client Sync",
  start: { dateTime: "2030-10-14T10:00:00Z" }, end: { dateTime: "2030-10-14T10:45:00Z" },
  response_status: "needsAction", can_respond: true, conflicts: [],
  organizer: { displayName: "Priya Mehta", email: "priya@example.test" },
  attendees: [{ email: "owner@example.test", self: true, response_status: "needsAction" }, { email: "priya@example.test", response_status: "accepted" }],
};
const calendarPeople = new Map([
  ["owner@example.test", { userId: "owner", displayName: null, photoUrl: photo }],
  ["priya@example.test", { userId: "priya", displayName: "Priya Mehta", photoUrl: photo }],
]);

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-14T09:00:00Z"));
  CacheService.getInstance().clear();
  mock.apiFetch.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(matchedUserId: string, workspaceLayout: boolean) {
  mock.apiFetch.mockResolvedValue(new Response(JSON.stringify({
    events: [event], people: { "priya@example.test": { userId: matchedUserId, photoUrl: photo } },
    pending_count: 1, unreadable_calendars: [], start_at: "2030-10-14T00:00:00Z", end_at: "2031-01-12T00:00:00Z", time_zone: "UTC", complete: true,
  }), { headers: { "Content-Type": "application/json" } }));
  return render(<CalendarInvitations workspaceLayout={workspaceLayout} calendarPeople={calendarPeople} userId="owner" accountEmail="owner@example.test" zone="UTC" getIdToken={async () => "synthetic-firebase"} onConnect={vi.fn()} />);
}

describe("Calendar invitation profile navigation", () => {
  it.each([false, true])("opens a connected profile independently of its invitation (workspace=%s)", async workspaceLayout => {
    const opened = vi.fn();
    window.addEventListener("hussh:person-profile-preview", opened);
    try {
      mount("priya", workspaceLayout);
      const card = await screen.findByRole("button", { name: "Open invitation: Client Sync" });
      fireEvent.click(screen.getByRole("button", { name: "View Priya Mehta's profile" }));
      expect(opened).toHaveBeenCalledOnce();
      expect((opened.mock.calls[0][0] as CustomEvent).detail.userId).toBe("priya");
      expect(screen.queryByRole("article", { name: "Invitation details: Client Sync" })).toBeNull();
      fireEvent.click(card);
      const detail = screen.getByRole("article", { name: "Invitation details: Client Sync" });
      expect(within(detail).getByRole("button", { name: "View Priya Mehta's profile" })).toBeInTheDocument();
      expect(within(detail).queryByRole("button", { name: "View You's profile" })).toBeNull();
    } finally {
      window.removeEventListener("hussh:person-profile-preview", opened);
    }
  });

  it("does not use a stale connection identity for a different fresh match", async () => {
    mount("new-owner-of-address", true);
    await screen.findByRole("button", { name: "Open invitation: Client Sync" });
    expect(screen.queryByRole("button", { name: /view .*profile/i })).toBeNull();
  });
});
