import "../fixtures/api-service-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

function json(body: unknown) { return Response.json(body); }

beforeEach(() => {
  publishValidatedAuthSessionPrincipal({ firebaseUid: "uid-owner", ownerId: "uid-owner", accountGeneration: 0 });
  vi.mocked(AuthService.getCurrentUser).mockReturnValue({ uid: "uid-owner" } as ReturnType<typeof AuthService.getCurrentUser>);
  vi.spyOn(ApiService, "getFirebaseToken").mockResolvedValue("synthetic-firebase-token");
});
afterEach(() => vi.restoreAllMocks());

describe("Direct private memory consent", () => {
  it("applies a processing grant directly and withdraws without hub issuance", async () => {
    const direct = vi.spyOn(ApiService, "ownerPodRequest").mockResolvedValue(json({ provider: { consent: "granted" } }));
    const hub = vi.spyOn(ApiService, "apiFetch").mockResolvedValue(json({
      hushhId: "ha1_owner", providerConsentToken: "synthetic-provider-grant", expiresAt: Date.now() + 300000,
    }));
    const result = await ApiService.setPodMemoryProviderConsent("ha1_owner", true);
    expect(result?.hushhId).toBe("ha1_owner");
    expect(hub).toHaveBeenCalledOnce();
    expect(hub.mock.calls[0][0]).toBe("/api/one/u/ha1_owner/memory/provider-grant");
    expect(direct.mock.calls[0][0]).toBe("memory/provider-consent");
    expect(JSON.parse(String(direct.mock.calls[0][1]?.body))).toEqual({ granted: true, providerConsentToken: "synthetic-provider-grant" });
    expect(direct.mock.calls[0][4]).toBe("ha1_owner");
    direct.mockResolvedValue(json({ provider: { consent: "revoked" } }));
    hub.mockClear().mockRejectedValue(new Error("hub unavailable"));
    await ApiService.setPodMemoryProviderConsent("ha1_owner", false);
    direct.mockResolvedValue(json({ provider: { consent: "revoked" } }));
    expect((await ApiService.getPodMemoryStatus("ha1_owner"))?.hushhId).toBe("ha1_owner");
    expect(hub).not.toHaveBeenCalled();
    expect(JSON.parse(String(direct.mock.calls[1][1]?.body))).toEqual({ granted: false });
    expect(direct.mock.calls[2][0]).toBe("memory/status");
  });

  it.each(["wrong-pod", "expired", "account-switch", "vault-switch"])("refuses %s before applying a processing grant", async (failure) => {
    const direct = vi.spyOn(ApiService, "ownerPodRequest");
    vi.spyOn(ApiService, "apiFetch").mockImplementation(async () => {
      if (failure === "account-switch") publishValidatedAuthSessionPrincipal({ firebaseUid: "uid-other", ownerId: "uid-other", accountGeneration: 1 });
      if (failure === "vault-switch") advanceVaultSessionEpoch("test-memory-consent");
      return json({ hushhId: failure === "wrong-pod" ? "ha1_other" : "ha1_owner",
        providerConsentToken: "synthetic-provider-grant", expiresAt: Date.now() + (failure === "expired" ? -1 : 300000) });
    });
    await expect(ApiService.setPodMemoryProviderConsent("ha1_owner", true)).rejects.toThrow();
    expect(direct).not.toHaveBeenCalled();
  });

});
