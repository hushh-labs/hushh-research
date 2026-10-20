import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: fetcher } }));
import { PrivateTextApprovalService } from "@/lib/services/private-text-approval-service";
import { PRIVATE_TEXT_DISCLOSURE_VERSION } from "@/lib/legal/private-text-disclosure";
const approved = { provider: "azure_openai", disclosure_version: PRIVATE_TEXT_DISCLOSURE_VERSION, enabled: true, generation: "11111111-1111-4111-8111-111111111111", accepted_at: "2026-10-19T08:00:00Z", revoked_at: null };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
describe("private Azure text approval boundary", () => {
  beforeEach(() => vi.resetAllMocks());
  it("sends current disclosure and Firebase auth without a client owner; revoke needs no new acceptance", async () => {
    fetcher.mockResolvedValueOnce(reply(approved));
    expect(await PrivateTextApprovalService.set("owner-token", true, null)).toEqual(approved);
    expect(fetcher).toHaveBeenLastCalledWith("/api/one/models/private-text-approval?include_policy=true", {
      method: "PUT", cache: "no-store", headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, disclosure_version: PRIVATE_TEXT_DISCLOSURE_VERSION, expected_generation: null }),
    });
    fetcher.mockResolvedValueOnce(reply({ ...approved, enabled: false, revoked_at: "2026-10-19T08:01:00Z" }));
    expect((await PrivateTextApprovalService.set("owner-token", false, approved.generation)).enabled).toBe(false);
    expect(JSON.parse(fetcher.mock.lastCall![1].body)).toEqual({ enabled: false, expected_generation: approved.generation });
  });
  it("keeps administrator default separate from owner acknowledgment and revokes with owner CAS", async () => {
    const defaultPolicy = { provider: "azure_openai", disclosure_version: PRIVATE_TEXT_DISCLOSURE_VERSION,
      enabled: false, generation: null, accepted_at: null, revoked_at: null,
      processing_policy: { enabled: true, basis: "uat_policy", version: "uat-drive-azure-default-v1",
        generation: "22222222-2222-4222-8222-222222222222", scope: "one_text_chat_and_drive_requests" } };
    fetcher.mockResolvedValueOnce(reply(defaultPolicy));
    const status = await PrivateTextApprovalService.get("token");
    expect(status?.enabled).toBe(false);
    expect(status?.processing_policy?.enabled).toBe(true);
    fetcher.mockResolvedValueOnce(reply({ ...defaultPolicy, processing_policy: { ...defaultPolicy.processing_policy, enabled: false, basis: "disabled", generation: null, version: null } }));
    await PrivateTextApprovalService.set("token", false, status!.generation);
    expect(JSON.parse(fetcher.mock.lastCall![1].body)).toEqual({ enabled: false, expected_generation: null });
  });
  it("fails closed on stale, unpersisted or mismatched acknowledgments", async () => {
    for (const payload of [{ ...approved, disclosure_version: "old" }, { ...approved, generation: null }, { ...approved, accepted_at: null }, { ...approved, revoked_at: "2026-10-19T08:01:00Z" }, { ...approved, enabled: false }]) {
      fetcher.mockResolvedValueOnce(reply(payload));
      await expect(PrivateTextApprovalService.set("owner-token", true, null)).rejects.toThrow();
    }
    fetcher.mockResolvedValueOnce(reply(approved));
    await expect(PrivateTextApprovalService.set("owner-token", false, approved.generation)).rejects.toThrow("not acknowledged");
  });
  it("hides only unavailable pilots and keeps auth/store failures retryable", async () => {
    fetcher.mockResolvedValueOnce(reply({ detail: { code: "PRIVATE_AZURE_TEXT_UAT_ONLY" } }, 403));
    expect(await PrivateTextApprovalService.get("token")).toBeNull();
    expect(fetcher.mock.lastCall![1]).toMatchObject({ method: "GET", cache: "no-store", headers: { Authorization: "Bearer token" } });
    for (const status of [401, 403, 503]) {
      fetcher.mockResolvedValueOnce(reply({ detail: { code: "OTHER_ERROR" } }, status));
      await expect(PrivateTextApprovalService.get("token")).rejects.toMatchObject({ status });
    }
  });
});
