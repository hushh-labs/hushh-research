import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ principal: { ownerId: "owner", firebaseUid: "firebase-owner" } as { ownerId: string; firebaseUid: string } | null, token: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth/session-owner", () => ({ snapshotValidatedAuthSessionPrincipal: () => ports.principal }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdTokenWithRetry: ports.token } }));
vi.mock("@/lib/services/account-identity-service", () => ({ AccountIdentityService: { refreshIdentityForSession: ports.read } }));
import { parseAccountContextRequest, readAccountContext } from "@/lib/services/account-chat-context";

beforeEach(() => { vi.clearAllMocks(); ports.principal = { ownerId: "owner", firebaseUid: "firebase-owner" }; ports.token.mockResolvedValue("fixture-proof"); });
describe("private account context", () => {
  it("reads committed identity once, masks contacts and keeps unknown values", async () => {
    ports.read.mockResolvedValue({ user_id: "owner", display_name: "Mira Iyer", email: "mira@example.test", phone_number: "+15551234826", email_verified: true, phone_verified: undefined, photo_url: null, created_at: "2025-01-01" });
    const result = await readAccountContext("owner", () => true);
    expect(ports.read).toHaveBeenCalledExactlyOnceWith("owner", "fixture-proof", { readOnly: true, requireSuccess: true });
    expect(result).toMatchObject({ status: "ok", identity: { display_name: "Mira Iyer", masked_email: "***@example.test", masked_phone: "••• 4826", email_verified: true, phone_verified: null, has_photo: false, last_synced_at: null } });
    expect(JSON.stringify(result)).not.toMatch(/mira@|15551234|created_at|2025-01-01/);
  });
  it.each(["foreign", "expired", "error", "missing"])("does not disclose an %s read", async reason => {
    let current = true;
    ports.read.mockImplementation(async () => { if (reason === "error") throw new Error("private details"); if (reason === "expired") current = false; return reason === "missing" ? null : { user_id: reason === "foreign" ? "other" : "owner", display_name: "PRIVATE" }; });
    expect(await readAccountContext("owner", () => current)).toEqual({ status: "unavailable", reason: "identity_unavailable" });
  });
  it("refuses missing owner and unknown or mutation inputs", async () => {
    ports.principal = null;
    expect(await readAccountContext("owner", () => true)).toMatchObject({ status: "unavailable" });
    expect(ports.token).not.toHaveBeenCalled(); expect(ports.read).not.toHaveBeenCalled();
    expect(parseAccountContextRequest({ section: "identity", owner: "other" })).toBeNull();
    expect(parseAccountContextRequest({ section: "identity", confirmed: true })).toBeNull();
  });
});
