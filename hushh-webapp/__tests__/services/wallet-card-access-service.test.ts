import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.fetch } }));
import { WalletCardAccessService, cardAccessReference } from "@/lib/services/wallet-card-access-service";

const context = { userId: "owner", vaultKey: "never-send-key", vaultOwnerToken: "consent", getIdToken: async () => "identity", isCurrent: () => true };
beforeEach(() => { mocks.fetch.mockReset(); mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ grants: [] }))); });
describe("temporary manual card access boundary", () => {
  it("keeps requests metadata-only and responses bound to their request with dual owner auth", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id, status: "pending", role: "requester", requesterPersonRef: id, requesterName: "One", ownerName: "Two", createdAt: "2026-10-16T00:00:00Z", expiresAt: "2026-10-23T00:00:00Z" })));
    await WalletCardAccessService.createRequest(context, id, id);
    const [path, options] = mocks.fetch.mock.calls[0];
    expect(path).toBe("/api/one/wallet/card-access/requests");
    expect(JSON.parse(options.body)).toEqual({ personRef: id, requestId: id });
    expect(options.headers).toMatchObject({ Authorization: "Bearer identity", "X-Hushh-Consent": "consent" });
    expect(JSON.stringify(options)).not.toContain(context.vaultKey);
    await WalletCardAccessService.share(context, "card", [id], 15, id, { [id]: "encrypted" }, id);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).cardRequestId).toBe(id);
  });
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

it("forwards cancellation for superseded connection searches", async () => {
  const controller = new AbortController();
  await WalletCardAccessService.recipients(context, "test", controller.signal);
  expect(mocks.fetch.mock.calls[0][1].signal).toBe(controller.signal);
});
it("reports service unavailability without exposing backend diagnostics", async () => {
  mocks.fetch.mockResolvedValue(new Response("internal diagnostic", { status: 503 }));
  await expect(WalletCardAccessService.state(context, "card_1")).rejects.toThrow("Card sharing is temporarily unavailable.");
});
it("forwards the history cursor without losing cancellation or owner consent", async () => {
  const controller = new AbortController();
  await WalletCardAccessService.state(context, "card_1", controller.signal, "11111111-1111-4111-8111-111111111111");
  const [url, options] = mocks.fetch.mock.calls[0];
  expect(url).toContain("/cards/card_1?cursor=11111111-1111-4111-8111-111111111111");
  expect(options.signal).toBe(controller.signal);
  expect(options.headers["X-Hushh-Consent"]).toBe(context.vaultOwnerToken);
});

it("refreshes only the initiating owner's ledger after a confirmed mutation", async () => {
  const owner = vi.fn(), other = vi.fn();
  const stop = WalletCardAccessService.subscribe("owner", owner);
  const stopOther = WalletCardAccessService.subscribe("other", other);
  await WalletCardAccessService.share(context, "profile_1", ["person_1"], 5, "request_1");
  expect(owner).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
  mocks.fetch.mockResolvedValueOnce(new Response("offline", { status: 503 }));
  await expect(WalletCardAccessService.revoke(context, "grant")).rejects.toThrow();
  expect(owner).toHaveBeenCalledOnce(); stop(); stopOther();
});

it("passes the final effect fence through the platform transport and never sends vault keys", async () => {
  await WalletCardAccessService.history(context, { direction: "received", cardType: "profile", cursor: "profile:opaque" });
  const [path, options] = mocks.fetch.mock.calls[0];
  expect(path).toContain("direction=received"); expect(path).toContain("cardType=profile");
  expect(options.isEffectCurrent).toBe(context.isCurrent);
  expect(JSON.stringify(options)).not.toContain(context.vaultKey);
});

it("checks current dispatch eligibility while accepting an already dispatched receipt", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let eligible = true;
  const dispatchContext = { ...context, canDispatch: () => eligible };
  mocks.fetch.mockImplementationOnce(async (_path, options) => {
    expect(options.isEffectCurrent()).toBe(true);
    eligible = false; // A same-session permission refresh begins after dispatch.
    expect(options.isEffectCurrent()).toBe(false);
    return new Response(JSON.stringify({ id, status: "pending", role: "requester", requesterPersonRef: id, requesterName: "One", ownerName: "Two", createdAt: "2026-10-16T00:00:00Z", expiresAt: "2026-10-23T00:00:00Z" }));
  });
  await expect(WalletCardAccessService.createRequest(dispatchContext, id, id)).resolves.toMatchObject({ id });
  await WalletCardAccessService.history(dispatchContext);
  expect(mocks.fetch.mock.calls[1][1].isEffectCurrent).toBe(context.isCurrent);
});

it.each(["WALLET_CARD_ACCESS_DISABLED", "WALLET_CARD_ACCESS_NOT_READY", "private_diagnostic"])("keeps only allowlisted readiness reason %s", async code => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ detail: { code } }), { status: 503 }));
  await expect(WalletCardAccessService.history(context)).rejects.toMatchObject({
    code: code === "private_diagnostic" ? "WALLET_CARD_ACCESS_UNAVAILABLE" : code,
    readinessUnavailable: code !== "private_diagnostic",
  });
});
