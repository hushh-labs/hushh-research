import { beforeEach, describe, expect, it, vi } from "vitest";
const placement = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@/lib/services/private-agent-specialist-chat', () => ({ ownerContentIsPrivate: placement }));


vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(), ownerPodRequest: vi.fn(),
  },
}));

import { ApiService } from "@/lib/services/api-service";
import { CacheService } from "@/lib/services/cache-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("GmailReceiptsService.getStatus caching", () => {
  beforeEach(() => {
    placement.mockResolvedValue(false);
    vi.restoreAllMocks();
    CacheService.getInstance().clear();
  });

  it('never reuses a shared cached grant or hub exchange after private placement', async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(jsonResponse({ connected: true, send_permission_granted: true }));
    await GmailReceiptsService.getStatus({ idToken: 'token', userId: 'owner' });
    vi.mocked(ApiService.apiFetch).mockClear();
    placement.mockResolvedValue(true);
    vi.mocked(ApiService.ownerPodRequest).mockResolvedValue(jsonResponse({ connectorId: 'gmail', status: 'connected', accessLevel: 'read', capabilities: { read: true, manage: false } }));
    const result = await GmailReceiptsService.getStatus({ idToken: 'token', userId: 'owner' });
    expect(result.send_permission_granted).toBe(false);
    expect(result.modify_permission_granted).toBe(false);
    await expect(GmailReceiptsService.completeNativeConnect({ idToken: 'token', userId: 'owner', serverAuthCode: 'must-not-reach-hub' })).rejects.toMatchObject({ code: 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE' });
    await expect(GmailReceiptsService.listReceipts({ idToken: 'token', vaultOwnerToken: 'owner-token', userId: 'owner' })).rejects.toMatchObject({ code: 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE' });
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
    expect(ApiService.ownerPodRequest).toHaveBeenCalledWith('connectors/gmail', { method: 'GET' });
  });

  it("serves a repeated call within the TTL from cache instead of hitting the network again", async () => {
    const fetchSpy = vi
      .spyOn(ApiService, "apiFetch")
      .mockResolvedValue(jsonResponse({ connected: true }));

    const first = await GmailReceiptsService.getStatus({
      idToken: "token-1",
      userId: "user-1",
    });
    const second = await GmailReceiptsService.getStatus({
      idToken: "token-1",
      userId: "user-1",
    });

    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when force is true", async () => {
    const fetchSpy = vi
      .spyOn(ApiService, "apiFetch")
      .mockImplementation(async () => jsonResponse({ connected: true }));

    await GmailReceiptsService.getStatus({ idToken: "token-1", userId: "user-1" });
    await GmailReceiptsService.getStatus({
      idToken: "token-1",
      userId: "user-1",
      force: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps separate cache entries per user", async () => {
    const fetchSpy = vi
      .spyOn(ApiService, "apiFetch")
      .mockImplementation(async () => jsonResponse({ connected: true }));

    await GmailReceiptsService.getStatus({ idToken: "token-1", userId: "user-1" });
    await GmailReceiptsService.getStatus({ idToken: "token-2", userId: "user-2" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

});
