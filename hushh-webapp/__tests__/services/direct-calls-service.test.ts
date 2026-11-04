import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectCallsService } from "@/lib/services/direct-calls-service";
import { publishPendingAuthSessionIdentity, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const harness = vi.hoisted(() => ({ uid: "firebase-alice", request: vi.fn(), sign: vi.fn(), identity: vi.fn() }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: harness.uid }) } }));
vi.mock("@/lib/services/api-client", () => ({ apiJson: (...args: unknown[]) => harness.request(...args) }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: vi.fn() } }));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  communicationIdentity: (...args: unknown[]) => harness.identity(...args),
  signCommunicationCommand: (...args: unknown[]) => harness.sign(...args),
}));
vi.mock("@/lib/direct-messages/call-crypto", () => ({ digest: vi.fn(), verifyCommunicationDevices: vi.fn() }));

const principal = { firebaseUid: "firebase-alice", ownerId: `acct_${"a".repeat(32)}`, accountGeneration: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); harness.uid = principal.firebaseUid;
  publishValidatedAuthSessionPrincipal(principal);
  harness.sign.mockResolvedValue({ deviceId: "device" });
  harness.request.mockResolvedValue({ available: true });
});
afterEach(() => publishValidatedAuthSessionPrincipal(null));

describe("calling admitted owner and session fencing", () => {
  it("signs for canonical ownership while authenticating with Firebase", async () => {
    await new DirectCallsService(principal.ownerId, async () => "synthetic-token").heartbeat("call");
    expect(harness.sign).toHaveBeenCalledWith(principal.ownerId, "heartbeat", { callId: "call" }, expect.any(Function));
    const options = harness.request.mock.calls[0]![1];
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer synthetic-token");
    expect(options.isEffectCurrent()).toBe(true);
    await expect(new DirectCallsService(principal.firebaseUid, async () => "unused").heartbeat("call")).rejects.toThrow("sign-in changed");
    expect(harness.sign).toHaveBeenCalledOnce();
  });

  it("does not send after admission is withdrawn during token retrieval", async () => {
    const token = deferred<string>();
    const pending = new DirectCallsService(principal.ownerId, () => token.promise).capabilities();
    publishPendingAuthSessionIdentity(principal.firebaseUid);
    token.resolve("synthetic-token");
    await expect(pending).rejects.toThrow("sign-in changed");
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("rejects a same-owner response from a previous validation episode", async () => {
    const response = deferred<unknown>(); harness.request.mockReturnValueOnce(response.promise);
    const pending = new DirectCallsService(principal.ownerId, async () => "synthetic-token").capabilities();
    await vi.waitFor(() => expect(harness.request).toHaveBeenCalledOnce());
    const options = harness.request.mock.calls[0]![1];
    publishPendingAuthSessionIdentity(principal.firebaseUid);
    publishValidatedAuthSessionPrincipal(principal);
    response.resolve({ available: true });
    await expect(pending).rejects.toThrow("sign-in changed");
    expect(options.isEffectCurrent()).toBe(false);
  });

  it("does not register a key after owner withdrawal during enrollment", async () => {
    const enrollment = deferred<unknown>(); harness.identity.mockReturnValueOnce(enrollment.promise);
    const pending = new DirectCallsService(principal.ownerId, async () => "synthetic-token").initialize();
    publishPendingAuthSessionIdentity(principal.firebaseUid);
    enrollment.resolve({ deviceId: "late-device" });
    await expect(pending).rejects.toThrow("sign-in changed");
    expect(harness.sign).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });
});
