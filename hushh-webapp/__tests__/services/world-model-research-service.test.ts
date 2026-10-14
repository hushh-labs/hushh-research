import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-client", () => ({
  apiJson: api,
  ApiError: class extends Error {
    status = 503;
  },
}));
vi.mock("@/lib/vault/one-chat-key", () => ({
  oneChatKeyHeaders: vi.fn(async () => ({ "X-Hussh-Chat-Key": "synthetic" })),
}));
import {
  WorldModelResearchService,
  pwmResultSchema,
} from "@/lib/services/world-model-research-service";
import { WorldModelInvitationsService } from "@/lib/services/world-model-invitations-service";
vi.mock("@/lib/share/app-origin", () => ({
  resolveShareableAppOrigin: () => "https://example.test",
}));
import { WorldModelSourceService } from "@/lib/services/world-model-source-service";
const session = {
  vaultKey: "synthetic-key",
  vaultOwnerToken: "synthetic-token",
};
describe("PWM service authority and request recovery", () => {
  beforeEach(() => {
    api.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  it("automatically ensures once, then reads the existing job", async () => {
    api
      .mockResolvedValueOnce({
        status: "pending",
        pkm_written: false,
        restart_required: false,
      })
      .mockResolvedValueOnce({ status: "saved", pkm_written: false });
    const onResult = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult,
    });
    await vi.runAllTimersAsync();
    await run;
    expect(api.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ["/api/one/world-model/ensure", "POST"],
      ["/api/one/world-model/jobs", "GET"],
    ]);
    expect(onResult).toHaveBeenCalledTimes(2);
  });
  it("reads after an uncertain POST response, without starting duplicate work", async () => {
    api
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce({ status: "saved", pkm_written: false });
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult: vi.fn(),
    });
    await vi.runAllTimersAsync();
    await run;
    expect(api.mock.calls[1][1].method).toBe("GET");
  });
  it("requires fresh authority before dispatch", async () => {
    const check = vi.fn().mockRejectedValue(new Error("owner changed"));
    await expect(
      WorldModelResearchService.preferences({
        ...session,
        assertCurrent: check,
      }),
    ).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });
  it("separates explicit refresh from automatic ensure", async () => {
    api.mockResolvedValue({ status: "saved", pkm_written: false });
    await WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      refresh: true,
      onResult: vi.fn(),
    });
    expect(api.mock.calls[0][0]).toBe("/api/one/world-model/jobs");
    expect(api.mock.calls[0][1].method).toBe("POST");
  });
  it("rejects extra private fields in a status payload", () => {
    expect(
      pwmResultSchema.safeParse({
        status: "saved",
        pkm_written: false,
        secret: "unexpected",
      }).success,
    ).toBe(false);
  });
  it("does not mistake an older draft for a failed preparation", async () => {
    api
      .mockRejectedValueOnce(new Error("request lost"))
      .mockResolvedValue({ status: "offered", draft_id: "old-alice" });
    await expect(
      WorldModelSourceService.prepare(session, {
        name: "Bob",
        urls: ["https://example.test/bob"],
        purpose: "invitation",
        permitted_public_sources: true,
      }),
    ).rejects.toThrow("request lost");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("puts invitation capability in a fragment, never in the query string", async () => {
    const token = "a".repeat(43);
    api.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      token,
      expires_at: "2030-01-01",
    });
    const result = await WorldModelInvitationsService.create(
      session,
      "recipient@example.test",
      {
        preview_draft_id: "00000000-0000-4000-8000-000000000002",
        selected_fact_ids: ["career:0"],
        introduction: "Hello",
      },
    );
    const url = new URL(result.url);
    expect(url.pathname).toBe("/world-model/invite");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#claim=${token}`);
    expect(JSON.parse(api.mock.calls[0][1].body).selected_fact_ids).toEqual([
      "career:0",
    ]);
  });
  it("accepts only the generic valid response for a previewless invitation", async () => {
    const token = "a".repeat(43);
    api.mockResolvedValueOnce({ has_preview: false });
    await expect(WorldModelInvitationsService.preview(token)).resolves.toEqual({
      has_preview: false,
    });
    expect(api.mock.calls[0][0]).toBe(
      "/api/one/world-model/invitation-preview",
    );
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ token });
    api.mockResolvedValueOnce({ has_preview: false, introduction: "invented" });
    await expect(WorldModelInvitationsService.preview(token)).rejects.toThrow();
  });
});
