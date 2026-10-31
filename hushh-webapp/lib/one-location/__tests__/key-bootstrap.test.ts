import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ state: vi.fn(), register: vi.fn(), recover: vi.fn(), local: vi.fn(), attach: vi.fn() }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { getState: ports.state, registerRecipientKey: ports.register } }));
vi.mock("@/lib/one-location/encryption", () => ({ ensureVaultSyncedRecipientKey: ports.recover, ensureLocationRecipientKey: ports.local }));
vi.mock("@/lib/one-location/location-bus", () => ({ LocationBus: { attachUser: ports.attach } }));
import { bootstrapCurrentUserLocationRecipientKey as bootstrap } from "../key-bootstrap";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const session = { userId: "owner", vaultOwnerToken: "owner-token", vaultKey: "vault-key", strictRecovery: true };
const remote = { keyId: "account-key", publicKeyJwk: { kty: "EC" }, encryptedPrivateKeyJwk: { ciphertext: "sealed" } };
const recovered = { ...remote, algorithm: "ECDH-P256-AES256-GCM" };
beforeEach(() => {
  vi.resetAllMocks();
  publishValidatedAuthSessionOwner(null);
  advanceVaultSessionEpoch();
  ports.state.mockResolvedValue({ myRecipientKey: remote });
  ports.recover.mockResolvedValue(recovered);
  ports.register.mockResolvedValue({ ...recovered, canReceiveLocation: true });
  ports.attach.mockResolvedValue(undefined);
});

describe("canonical Location key bootstrap", () => {
  it("joins concurrent warm/page/setup calls and registers the recovered account key once", async () => {
    let finish!: (value: unknown) => void;
    ports.state.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const warm = bootstrap(session);
    const page = bootstrap(session);
    expect(page).toBe(warm);
    expect(ports.recover).not.toHaveBeenCalled();
    finish({ myRecipientKey: remote });
    await Promise.all([warm, page]);
    expect(ports.state).toHaveBeenCalledTimes(1);
    expect(ports.recover).toHaveBeenCalledWith({ userId: "owner", vaultKey: "vault-key", remoteBackup: remote, strictRecovery: true });
    expect(ports.register).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "owner-token", ...recovered });
    expect(ports.local).not.toHaveBeenCalled();
  });

  it("never creates or replaces a key after an unknown remote read; a later attempt recovers", async () => {
    ports.state.mockRejectedValueOnce(new Error("offline"));
    await expect(bootstrap(session)).rejects.toThrow("offline");
    expect(ports.recover).not.toHaveBeenCalled();
    expect(ports.register).not.toHaveBeenCalled();
    await bootstrap(session);
    expect(ports.register).toHaveBeenCalledTimes(1);
    ports.recover.mockRejectedValueOnce(new Error("backup cannot be decrypted"));
    await expect(bootstrap(session)).rejects.toThrow("backup cannot be decrypted");
    expect(ports.register).toHaveBeenCalledTimes(1);
  });

  it("defaults every vault-backed caller to strict recovery", async () => {
    const { strictRecovery: _strict, ...implicit } = session;
    ports.state.mockRejectedValueOnce(new Error("offline"));
    await expect(bootstrap(implicit)).rejects.toThrow("offline");
    expect(ports.recover).not.toHaveBeenCalled();
    expect(ports.register).not.toHaveBeenCalled();
    await bootstrap(implicit);
    expect(ports.recover).toHaveBeenCalledWith(expect.objectContaining({ strictRecovery: true }));
  });

  it("never interprets an omitted own-key projection as permission to replace a key", async () => {
    ports.state.mockResolvedValueOnce({});
    await expect(bootstrap(session)).rejects.toThrow("could not be checked");
    expect(ports.recover).not.toHaveBeenCalled();
    expect(ports.register).not.toHaveBeenCalled();
    ports.state.mockResolvedValueOnce({ myRecipientKey: null });
    await bootstrap(session);
    expect(ports.recover).toHaveBeenCalledWith(expect.objectContaining({ remoteBackup: null, strictRecovery: true }));
    expect(ports.register).toHaveBeenCalledTimes(1);
  });

  it.each(["state", "recover"] as const)("fences a lock during %s and allows the new session to recover", async (stage) => {
    let finish!: (value: unknown) => void;
    ports[stage].mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldSession = bootstrap(session);
    // Let the remote read complete before pausing recovery.
    await Promise.resolve();
    advanceVaultSessionEpoch();
    const currentSession = bootstrap(session);
    expect(currentSession).not.toBe(oldSession);
    const rejected = expect(oldSession).rejects.toThrow("session changed");
    finish(stage === "state" ? { myRecipientKey: remote } : recovered);
    await rejected;
    await currentSession;
    expect(ports.register).toHaveBeenCalledTimes(1);
  });

  it("fences an account switch without registering the old owner's key", async () => {
    publishValidatedAuthSessionOwner("owner");
    let finish!: (value: unknown) => void;
    ports.state.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldSession = bootstrap(session);
    publishValidatedAuthSessionOwner("other");
    const rejected = expect(oldSession).rejects.toThrow("session changed");
    finish({ myRecipientKey: remote });
    await rejected;
    expect(ports.recover).not.toHaveBeenCalled();
    expect(ports.register).not.toHaveBeenCalled();
  });

  it("serializes a changed vault session and never joins another account", async () => {
    let finish!: (value: unknown) => void;
    ports.state.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = bootstrap(session);
    const renewed = bootstrap({ ...session, vaultOwnerToken: "new-token" });
    const other = bootstrap({ ...session, userId: "other", vaultOwnerToken: "other-token" });
    await other;
    expect(ports.state).toHaveBeenCalledTimes(2);
    finish({ myRecipientKey: remote });
    await Promise.all([first, renewed]);
    expect(ports.state).toHaveBeenLastCalledWith("new-token");
    expect(ports.register).toHaveBeenCalledTimes(3);
  });
});
