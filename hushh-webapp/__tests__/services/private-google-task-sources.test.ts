import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "@/lib/services/api-service";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { privateCalendarEvents, privateMailTasks } from "@/lib/services/private-google-task-sources";

vi.mock("@/lib/services/api-service", () => ({ ApiService: { ownerPodRequest: vi.fn(), apiFetch: vi.fn() } }));
vi.mock("@/lib/services/private-agent-specialist-chat", () => ({ ownerContentIsPrivate: async () => true }));
const pod = vi.mocked(ApiService.ownerPodRequest);

describe("bounded private Google task reads", () => {
  beforeEach(() => vi.clearAllMocks());
  it("recovers a transient private recent-mail read on the same grant", async () => {
    vi.useFakeTimers();
    try {
      pod.mockResolvedValueOnce(Response.json({detail: {code: "MAIL_FOLLOWUP_UNAVAILABLE"}}, {status: 503}))
        .mockResolvedValueOnce(Response.json({items: []}));
      const signal = new AbortController().signal;
      const result = MailFollowupsService.recent({account: "slot", connection: "grant", address: "a@example.test"}, signal);
      await vi.advanceTimersByTimeAsync(1200);
      await expect(result).resolves.toEqual({items: []});
      expect(pod).toHaveBeenCalledTimes(2);
      for (const [path, init] of pod.mock.calls) {
        expect(path).toBe("gmail/followups/recent");
        expect(JSON.parse(String(init?.body))).toEqual({account: "slot", connection: "grant"});
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([undefined, 1] as const)("confirms the exact private Calendar review with contract %s", async reviewContract => {
    const proposalId = `gcal_${"a".repeat(24)}`;
    pod.mockResolvedValue(Response.json({ proposalId, kind: "calendar", result: { action: "create", event: {} } }));
    await GoogleCalendarService.executeProposal({
      vaultOwnerToken: "fixture-vault", userId: "owner", proposalId,
      ...(reviewContract === 1 ? { reviewContract } : {}),
    });
    expect(pod).toHaveBeenCalledExactlyOnceWith(`actions/${proposalId}/confirm`, reviewContract === 1 ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ review_contract: 1 }),
    } : { method: "POST" });
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
  });
  it("routes Calendar content only to the owner's pod without sending a hub/vault token", async () => {
    pod.mockResolvedValue(Response.json({ events: [], time_zone: "Asia/Kolkata", truncated: false }));
    const input = { vaultOwnerToken: "fixture-vault", startAt: "2026-11-03T00:00:00Z", endAt: "2026-11-10T00:00:00Z" };
    expect(await GoogleCalendarService.listEvents(input)).toMatchObject({ events: [], truncated: false });
    expect(pod).toHaveBeenCalledWith("calendar/events", expect.objectContaining({ method: "POST", cache: "no-store" }));
    const sent = String(pod.mock.calls[0]![1]!.body);
    expect(JSON.parse(sent)).toEqual({ start_at: input.startAt, end_at: input.endAt });
    expect(sent).not.toContain(input.vaultOwnerToken);
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
  });
  it("preserves typed Calendar reconnect recovery and never falls back to the hub", async () => {
    pod.mockResolvedValue(Response.json({ detail: { reason_code: "calendar_reauthorization_required" } }, { status: 401 }));
    await expect(privateCalendarEvents({ startAt: "start", endAt: "end" })).rejects.toMatchObject({ recovery: "reconnect" });
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
  });
  it("rejects unexpected private provider fields instead of releasing them to the page", async () => {
    pod.mockResolvedValue(Response.json({ items: [{ key: "a".repeat(64), title: "Reply to Saru", message_body: "must not escape" }], complete: true, scope: "recent_threads" }));
    await expect(privateMailTasks({ isCurrent: () => true })).rejects.toThrow();
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
  });
  it("withholds a delayed mail response after the owner/session changes", async () => {
    let current = true;
    let finish!: (response: Response) => void;
    pod.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = privateMailTasks({ isCurrent: () => current });
    current = false;
    finish(Response.json({ items: [{ key: "a".repeat(64), title: "Reply to Saru" }], complete: false, scope: "recent_threads" }));
    await expect(result).rejects.toThrow("Session changed");
  });
});
