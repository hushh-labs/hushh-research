import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.fetch } }));
import { WalletCardAccessService, cardAccessReference } from "@/lib/services/wallet-card-access-service";

const context = { userId: "owner", vaultKey: "never-send-key", vaultOwnerToken: "consent", getIdToken: async () => "identity", isCurrent: () => true };
beforeEach(() => { mocks.fetch.mockReset(); mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ grants: [] }))); });
describe("temporary manual card access boundary", () => {
  it("sends references, duration and replay key with dual owner auth only", async () => {
    await WalletCardAccessService.share(context, "card_1", ["person_1", "person_2"], 10, "request_1");
    const [path, options] = mocks.fetch.mock.calls[0];
    expect(path).toBe("/api/one/wallet/card-access/cards/card_1/grants");
    expect(options.headers).toMatchObject({ Authorization: "Bearer identity", "X-Hushh-Consent": "consent" });
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(options.body)).toEqual({ requestId: "request_1", recipientPersonRefs: ["person_1", "person_2"], durationMinutes: 10 });
    expect(JSON.stringify(options)).not.toContain("never-send-key");
  });
  it("does not send after an owner change while retrieving the token", async () => {
    let current = true;
    await expect(WalletCardAccessService.state({ ...context, getIdToken: async () => { current = false; return "identity"; }, isCurrent: () => current }, "card_1")).rejects.toThrow("Wallet changed");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("never exposes backend error contents", async () => {
    mocks.fetch.mockResolvedValue(new Response("internal sensitive diagnostic", { status: 500 }));
    await expect(WalletCardAccessService.view("identity", "grant")).rejects.toThrow("Card access is unavailable");
  });
  it("uses recipient identity without an owner's consent or vault key", async () => {
    await WalletCardAccessService.view("recipient", "grant");
    expect(mocks.fetch.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer recipient", "Content-Type": "application/json" });
  });
  it("recognizes exact bounded references only, never arbitrary message text", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(cardAccessReference(`[wallet-access:${id}]`)).toBe(id);
    expect(cardAccessReference(`text [wallet-access:${id}]`)).toBeNull();
    expect(cardAccessReference("[wallet-access:javascript:bad]")).toBeNull();
  });
});
