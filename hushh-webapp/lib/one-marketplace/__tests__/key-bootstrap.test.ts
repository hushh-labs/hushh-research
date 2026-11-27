import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootstrapCurrentUserMarketplaceRecipientKey } from "@/lib/one-marketplace/key-bootstrap";

const ports = vi.hoisted(() => ({ key: vi.fn(), register: vi.fn() }));
vi.mock("@/lib/one-marketplace/encryption", () => ({ ensureMarketplaceRecipientKey: ports.key }));
vi.mock("@/lib/one-marketplace/service", () => ({ OneMarketplaceService: { registerRecipientKey: ports.register } }));
const key = { keyId: "published-key", publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, algorithm: "ECDH-P256-AES256-GCM" };
beforeEach(() => {
  vi.resetAllMocks();
  ports.key.mockResolvedValue(key);
  ports.register.mockResolvedValue({ userId: "requester", ...key });
});
afterEach(() => vi.useRealTimers());

it("accepts only an acknowledgement bound to this owner and exact public key", async () => {
  await expect(bootstrapCurrentUserMarketplaceRecipientKey({ userId: "requester", vaultOwnerToken: "owner-token" })).resolves.toMatchObject(key);
  expect(ports.register).toHaveBeenCalledWith({ vaultOwnerToken: "owner-token", ...key });
  ports.register.mockResolvedValue({ userId: "different-owner", ...key });
  await expect(bootstrapCurrentUserMarketplaceRecipientKey({ userId: "requester", vaultOwnerToken: "owner-token" })).rejects.toThrow("could not be verified");
  ports.register.mockResolvedValue({ userId: "requester", ...key, publicKeyJwk: { ...key.publicKeyJwk, x: "different-key" } });
  await expect(bootstrapCurrentUserMarketplaceRecipientKey({ userId: "requester", vaultOwnerToken: "owner-token" })).rejects.toThrow("could not be verified");
});

it("does not publish when custody changes during local key lookup", async () => {
  let active = true;
  ports.key.mockImplementation(async () => { active = false; return key; });
  await expect(bootstrapCurrentUserMarketplaceRecipientKey({ userId: "requester", vaultOwnerToken: "owner-token", isCurrent: () => active })).rejects.toThrow("Session changed");
  expect(ports.register).not.toHaveBeenCalled();
});

it("bounds stalled storage and retires publication when it resolves after timeout", async () => {
  vi.useFakeTimers();
  let resolveKey!: (value: typeof key) => void;
  ports.key.mockReturnValue(new Promise(resolve => { resolveKey = resolve; }));
  const result = bootstrapCurrentUserMarketplaceRecipientKey({ userId: "requester", vaultOwnerToken: "owner-token" });
  const rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  resolveKey(key);
  await Promise.resolve();
  expect(ports.register).not.toHaveBeenCalled();
});
