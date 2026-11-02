import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "@/lib/services/api-service";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { privateCalendarEvents, privateMailTasks } from "@/lib/services/private-google-task-sources";

vi.mock("@/lib/services/api-service", () => ({ ApiService: { ownerPodRequest: vi.fn(), apiFetch: vi.fn() } }));
vi.mock("@/lib/services/private-agent-specialist-chat", () => ({ ownerContentIsPrivate: async () => true }));
const pod = vi.mocked(ApiService.ownerPodRequest);

describe("bounded private Google task reads", () => {
  beforeEach(() => vi.clearAllMocks());
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
