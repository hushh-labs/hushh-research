import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const ports = vi.hoisted(() => ({
  native: false, bootstrap: vi.fn(), update: vi.fn(), identity: vi.fn(),
  people: vi.fn(), gis: vi.fn(), permission: vi.fn(), phone: vi.fn(), google: vi.fn(),
  sync: vi.fn(), privacy: vi.fn(), circle: vi.fn(), add: vi.fn(), connections: vi.fn(), provider: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => ports.native } }));
vi.mock("@/lib/capacitor", () => ({
  HushhContacts: { requestPermission: ports.permission, readContacts: ports.phone },
  HushhAuth: { authorizeGoogleContacts: ports.google },
}));
vi.mock("@/lib/contacts/google-people-source", () => ({ googlePeopleContactSource: ports.people }));
vi.mock("@/lib/contacts/google-contacts-token", () => ({ requestGoogleContactsToken: ports.gis }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { bootstrapState: ports.bootstrap, updatePreVaultState: ports.update } }));
vi.mock("@/lib/services/account-identity-service", () => ({ AccountIdentityService: {
  refreshCurrentUserIdentity: ports.identity, hasVerifiedPhone: (identity: { verified?: boolean }) => identity?.verified === true,
} }));
vi.mock("@/lib/services/ria-service", () => ({ CONTACT_SYNC_MATCH_POLICY_VERSION: "v2", RiaService: { getContactDiscoverability: ports.privacy } }));
vi.mock("@/lib/one-location/contact-signals", () => ({ syncOneLocationContactSignals: ports.sync }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { bootstrapOnboardingCircle: ports.circle, addNamedCircleMembers: ports.add } }));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { listConnectionsPage: ports.connections } }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { initialContactsSignInProvider: ports.provider } }));

import { InitialContactsOnboardingService as service } from "@/lib/services/initial-contacts-onboarding-service";

const user = (uid = "owner") => ({ uid, email: "owner@example.test", getIdToken: vi.fn().mockResolvedValue(`token-${uid}`),
  getIdTokenResult: vi.fn().mockResolvedValue({ signInProvider: "apple.com" }) }) as unknown as User;
const read = { contacts: [{ id: "contact", name: "Person", phoneNumbers: ["+14155550101"] }], permission: "granted" };
const result = { matches: [], autoConnectedCount: 0, alreadyConnectedCount: 0, partial: false };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  service.reset(); publishValidatedAuthSessionOwner("owner"); vi.resetAllMocks(); ports.native = false;
  ports.bootstrap.mockResolvedValue({ setupCompleted: false, initialContactsWelcomeAcknowledged: null });
  ports.update.mockResolvedValue({}); ports.identity.mockResolvedValue({ verified: true, phone_number: "+14155550000" });
  ports.people.mockReturnValue(vi.fn().mockResolvedValue(read));
  ports.privacy.mockResolvedValue({ iam_schema_ready: true, contact_sync_match_policy_version: "v2" });
  ports.sync.mockResolvedValue(result); ports.circle.mockResolvedValue({ circleId: "circle", circleName: "Contacts", code: "ONE123" });
  ports.add.mockImplementation(async ({ inviteeUserIds }) => ({ added: inviteeUserIds }));
  ports.connections.mockResolvedValue({ items: [], hasMore: false });
  ports.permission.mockResolvedValue({ state: "limited" }); ports.phone.mockResolvedValue(read);
  ports.google.mockResolvedValue({ accessToken: "retry-token" }); ports.gis.mockResolvedValue("gis-token");
  ports.provider.mockResolvedValue("apple.com");
});

async function begin(provider: "google" | "apple" = "google", extra = {}) {
  return service.begin({ user: user(), idToken: "token-owner", isNewUser: true,
    contactsGrant: { accessToken: "ephemeral", authority: "firebase-signup" }, ...extra }, provider, "attempt", true);
}

describe("initial signup contacts", () => {
  it("reads during Google signup, but matches only after verified phone using the captured read", async () => {
    const book = deferred<typeof read>(); const source = vi.fn(() => book.promise); ports.people.mockReturnValue(source);
    await begin(); expect(source).toHaveBeenCalledTimes(1);
    ports.identity.mockResolvedValueOnce({ verified: false });
    await service.matchWhenVerified(); expect(ports.sync).not.toHaveBeenCalled();
    book.resolve(read); await service.matchWhenVerified();
    const options = ports.sync.mock.calls[0][0]; expect(options.context).toBe("signup");
    expect(await options.source()).toEqual(read); expect(ports.people).toHaveBeenCalledTimes(1);
    expect(ports.gis).not.toHaveBeenCalled(); expect(ports.phone).not.toHaveBeenCalled();
  });

  it("preserves the no-locale-guess contract when a verified phone hint is absent", async () => {
    ports.identity.mockResolvedValue({ verified: true, phone_number: null });
    await begin(); await service.matchWhenVerified();
    const resolveHint = ports.sync.mock.calls[0][0].resolveAccountPhoneNumber;
    expect(resolveHint).toBeTypeOf("function");
    expect(resolveHint()).toBeNull();
    publishValidatedAuthSessionOwner("other");
    expect(() => resolveHint()).toThrow("Ended");
  });

  it.each(["replacement", "same-owner-relogin"])("suppresses late work after %s", async (change) => {
    await begin(); const identity = deferred<{ verified: boolean }>(); ports.identity.mockReturnValue(identity.promise);
    const task = service.matchWhenVerified();
    publishValidatedAuthSessionOwner(change === "replacement" ? "other" : null);
    if (change === "same-owner-relogin") publishValidatedAuthSessionOwner("owner");
    identity.resolve({ verified: true }); await task; await service.prepareCircle("vault");
    expect(ports.sync).not.toHaveBeenCalled(); expect(ports.circle).not.toHaveBeenCalled(); expect(ports.add).not.toHaveBeenCalled();
    expect(service.snapshotForOwner("owner").ownerId).toBeNull();
  });

  it.each([false, undefined])("never acquires or enrolls an unenrolled account with newness %s", async (isNewUser) => {
    await begin("google", { isNewUser });
    expect(ports.people).not.toHaveBeenCalled(); expect(ports.update).not.toHaveBeenCalled();
    expect(service.getSnapshot().ownerId).toBeNull();
  });

  it("enrolls a new account created from sign-in without acquiring unrequested contacts", async () => {
    await service.begin({ user: user(), idToken: "token-owner", isNewUser: true }, "google", "signin-attempt", false);
    expect(service.getSnapshot()).toMatchObject({ ownerId: "owner", source: "google", status: "deferred" });
    expect(ports.update).toHaveBeenCalledWith("owner", { initialContactsSource: "google" }, { idToken: "token-owner" });
    expect(ports.people).not.toHaveBeenCalled();
    expect(ports.gis).not.toHaveBeenCalled();
    expect(ports.google).not.toHaveBeenCalled();
    expect(ports.permission).not.toHaveBeenCalled();
    expect(ports.phone).not.toHaveBeenCalled();
  });

  it("enrolls fresh signup after completed deletion clears the former account state", async () => {
    await begin();
    await service.acknowledge();
    service.reset();
    publishValidatedAuthSessionOwner("owner");
    ports.bootstrap.mockResolvedValue({ setupCompleted: false, initialContactsWelcomeAcknowledged: null });
    ports.people.mockClear();
    ports.update.mockClear();
    await begin();
    expect(service.getSnapshot().ownerId).toBe("owner");
    expect(ports.people).toHaveBeenCalledTimes(1);
    expect(ports.update).toHaveBeenCalledWith("owner", { initialContactsSource: "google" }, { idToken: "token-owner" });
  });

  it.each([true, null])("keeps existing setup state %s outside the initial flow even with new Firebase metadata", async (setupCompleted) => {
    ports.bootstrap.mockResolvedValue({ setupCompleted, initialContactsWelcomeAcknowledged: null });
    await begin();
    expect(ports.people).not.toHaveBeenCalled(); expect(ports.update).not.toHaveBeenCalled();
    expect(service.getSnapshot().ownerId).toBeNull();
  });

  it.each([false, undefined])("resumes an enrolled incomplete signup with newness %s", async (isNewUser) => {
    ports.bootstrap.mockResolvedValue({ setupCompleted: false, initialContactsWelcomeAcknowledged: false });
    await begin("google", { isNewUser });
    expect(ports.people).toHaveBeenCalledTimes(1);
    expect(ports.update).not.toHaveBeenCalled();
    expect(service.getSnapshot().ownerId).toBe("owner");
  });

  it("native Apple always uses phonebook, even with a stale Google source", async () => {
    ports.native = true; ports.bootstrap.mockResolvedValue({ setupCompleted: false, initialContactsSource: "google", initialContactsWelcomeAcknowledged: false });
    await begin("apple"); expect(service.getSnapshot().source).toBe("device");
    expect(ports.phone).not.toHaveBeenCalled(); service.startSource(); await service.matchWhenVerified();
    expect(ports.permission).toHaveBeenCalledTimes(1); expect(ports.phone).toHaveBeenCalledTimes(1);
    expect(ports.google).not.toHaveBeenCalled(); expect(ports.gis).not.toHaveBeenCalled(); expect(ports.people).not.toHaveBeenCalled();
  });

  it("restores native Apple from authoritative provider evidence without requesting Google", async () => {
    ports.native = true;
    await service.restore(user(), { initialContactsWelcomeAcknowledged: false, initialContactsSource: "google" } as never);
    expect(service.getSnapshot().source).toBe("device"); expect(ports.google).not.toHaveBeenCalled();
  });

  it("retains signup on denied contact permission and allows welcome acknowledgement", async () => {
    ports.native = true; await begin("apple"); ports.permission.mockResolvedValue({ state: "denied" });
    service.startSource(); await Promise.resolve(); await Promise.resolve();
    await service.acknowledge(); expect(service.wasDismissed("owner")).toBe(true);
    expect(ports.phone).not.toHaveBeenCalled(); expect(service.getSnapshot().ownerId).toBeNull();
  });

  it("fills at most 99 confirmed Contacts connections in bounded insert-only batches", async () => {
    const ids = Array.from({ length: 103 }, (_, index) => `person-${String(index).padStart(3, "0")}`);
    ports.sync.mockResolvedValue({ ...result, matches: [...ids.map((userId) => ({ userId, outcome: "auto_connected" })),
      { userId: "suppressed", outcome: "suppressed" }, { userId: "manual-only", outcome: "already_connected" }] });
    ports.connections.mockResolvedValue({ items: [...ids.map((userId) => ({ userId, connectedFromContacts: true })),
      { userId: "suppressed", connectedFromContacts: true }, { userId: "manual-only", connectedFromContacts: false }], hasMore: false });
    await begin(); await service.matchWhenVerified(); await service.prepareCircle("vault");
    const batches = ports.add.mock.calls.map(([options]) => options);
    expect(batches).toHaveLength(5); expect(batches.every((batch) => batch.context === "signup" && batch.inviteeUserIds.length <= 20)).toBe(true);
    expect(batches.flatMap((batch) => batch.inviteeUserIds)).toEqual(ids.slice(0, 99));
    expect(service.getSnapshot().overflow).toBe(4);
    await service.prepareCircle("vault"); expect(ports.add).toHaveBeenCalledTimes(5);
  });

  it("retries failed membership writes with a fresh vault token", async () => {
    ports.sync.mockResolvedValue({ ...result, matches: [{ userId: "person", outcome: "auto_connected" }] });
    ports.connections.mockResolvedValue({ items: [{ userId: "person", connectedFromContacts: true }], hasMore: false });
    await begin(); await service.matchWhenVerified(); ports.add.mockRejectedValueOnce({ status: 401 });
    await service.prepareCircle("expired"); await service.prepareCircle("fresh");
    expect(ports.add).toHaveBeenCalledTimes(2); expect(ports.add.mock.calls[1][0].vaultOwnerToken).toBe("fresh");
    expect(service.getSnapshot().membersAdded).toBe(1);
    expect(service.getSnapshot().circleError).toBeNull();
  });

  it("fills contacts that finish matching while the empty circle bootstrap awaits", async () => {
    const circle = deferred<{ circleId: string; circleName: string; code: string }>();
    ports.circle.mockReturnValue(circle.promise);
    ports.sync.mockResolvedValue({ ...result, matches: [{ userId: "friend", outcome: "auto_connected" }] });
    ports.connections.mockResolvedValue({ items: [{ userId: "friend", displayName: "Friend", photoUrl: "https://images.example.test/friend.jpg", connectedFromContacts: true }], hasMore: false });
    await begin(); const preparing = service.prepareCircle("vault");
    await Promise.resolve(); await service.matchWhenVerified();
    circle.resolve({ circleId: "circle", circleName: "Contacts", code: "ONE123" });
    await preparing;
    expect(ports.add).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "vault", circleId: "circle", inviteeUserIds: ["friend"], context: "signup" });
    expect(service.getSnapshot().people[0].photoUrl).toBe("https://images.example.test/friend.jpg");
  });

  it("lets a validated returning account continue from a direct welcome entry", async () => {
    await service.acknowledge(user());
    expect(service.wasDismissed("owner")).toBe(true);
    expect(ports.update).toHaveBeenCalledWith("owner", { initialContactsWelcomeAcknowledged: true }, { idToken: "token-owner" });
  });

  it("lets the current session continue after a failed durable welcome acknowledgement", async () => {
    await begin(); ports.update.mockRejectedValueOnce(new Error("offline"));
    await expect(service.acknowledge()).rejects.toThrow("offline");
    expect(service.wasDismissed("owner")).toBe(true);
    expect(service.getSnapshot().ownerId).toBeNull();
  });
});
