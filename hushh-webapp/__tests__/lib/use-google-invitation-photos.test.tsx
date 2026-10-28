import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { forgetGoogleInvitationPhotoGrant, useGoogleInvitationPhotos } from "@/lib/calendar/use-google-invitation-photos";
import { GOOGLE_GUEST_PHOTO_SCOPE, type GooglePhotoGrant } from "@/lib/services/google-invitation-photo-token";
import { GooglePhotoProviderError } from "@/lib/services/google-invitation-photos";

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn(), warm: vi.fn(async () => undefined) }));
vi.mock("@/lib/services/google-invitation-photo-token", async importOriginal => ({
  ...(await importOriginal<object>()), requestGoogleInvitationPhotoGrant: mocks.request,
}));
vi.mock("@/lib/services/google-invitation-photos", async importOriginal => ({
  ...(await importOriginal<object>()),
  lookupGoogleInvitationPhoto: mocks.lookup,
  warmGoogleContactsPhotoSearch: mocks.warm,
}));

const guest = "guest@example.com";
const photo = { url: "https://lh3.googleusercontent.com/-guest/photo.jpg", source: "google_profile" as const };
const account = (accountId: string, overrides: Record<string, unknown> = {}) => ({
  enabled: true, ownerId: "owner", accountId, accountEmail: `${accountId}@example.com`,
  subjectSha256: "a".repeat(64), grantGeneration: "b".repeat(64),
  grantedScopes: GOOGLE_GUEST_PHOTO_SCOPE, guestPhotoAccess: true,
  getIdToken: async () => "firebase-token", vaultOwnerToken: "vault-owner-token",
  guestEmails: [guest], ...overrides,
});
const grant = (email: string, ttl = 60_000): GooglePhotoGrant => ({
  token: "contacts-only", accountEmail: email, subject: "a".repeat(64),
  permission: "contacts", expiresAt: Date.now() + ttl,
});
beforeEach(() => {
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  mocks.request.mockImplementation(async (input: { accountEmail: string }) => grant(input.accountEmail));
  mocks.lookup.mockResolvedValue(photo);
});
afterEach(() => {
  forgetGoogleInvitationPhotoGrant();
  publishValidatedAuthSessionPrincipal(null);
  vi.clearAllMocks();
});

describe("automatic Calendar guest photos", () => {
  it("loads exact guest photos without a second Google prompt", async () => {
    const view = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await waitFor(() => expect(view.result.current.photos.get(guest)).toEqual(photo));
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      idToken: "firebase-token", vaultOwnerToken: "vault-owner-token",
      ownerId: "owner", accountId: "first", accountEmail: "first@example.com",
    }));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("leaves historical, declined, or locked grants as initials", async () => {
    const old = renderHook(() => useGoogleInvitationPhotos(account("first", { guestPhotoAccess: false })));
    expect(old.result.current.photos.size).toBe(0);
    old.unmount();
    const denied = renderHook(() => useGoogleInvitationPhotos(account("first", { grantedScopes: "calendar.events.readonly" })));
    expect(denied.result.current.photos.size).toBe(0);
    denied.unmount();
    const locked = renderHook(() => useGoogleInvitationPhotos(account("first", { vaultOwnerToken: null })));
    expect(locked.result.current.photos.size).toBe(0);
    locked.unmount();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("reuses a memory grant only for the same selected account and auth session", async () => {
    const first = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await waitFor(() => expect(first.result.current.photos.get(guest)).toEqual(photo));
    first.unmount();
    const reopened = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await waitFor(() => expect(reopened.result.current.photos.get(guest)).toEqual(photo));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    reopened.unmount();
    const second = renderHook(() => useGoogleInvitationPhotos(account("second")));
    await waitFor(() => expect(second.result.current.photos.get(guest)).toEqual(photo));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it("discards a late token from an account that is no longer selected", async () => {
    let release: ((value: GooglePhotoGrant) => void) | undefined;
    mocks.request.mockImplementationOnce(() => new Promise<GooglePhotoGrant>(resolve => { release = resolve; }))
      .mockImplementation(async (input: { accountEmail: string }) => grant(input.accountEmail));
    const view = renderHook(({ id }) => useGoogleInvitationPhotos(account(id)), { initialProps: { id: "first" } });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    view.rerender({ id: "second" });
    await act(async () => { release?.(grant("first@example.com")); });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.photos.get(guest)).toEqual(photo));
    expect(mocks.lookup.mock.calls.every(([value]: [GooglePhotoGrant]) => value.accountEmail === "second@example.com")).toBe(true);
    view.unmount();
  });

  it("drops photos when the vault locks or Google revokes the photo token", async () => {
    const view = renderHook(({ token }) => useGoogleInvitationPhotos(account("first", { vaultOwnerToken: token })), { initialProps: { token: "vault-owner-token" as string | null } });
    await waitFor(() => expect(view.result.current.photos.get(guest)).toEqual(photo));
    view.rerender({ token: null });
    expect(view.result.current.photos.size).toBe(0);
    view.unmount();
    mocks.lookup.mockRejectedValue(new GooglePhotoProviderError("revoked", "contacts"));
    const reopened = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await waitFor(() => expect(reopened.result.current.message).toMatch(/revoked/i));
    expect(reopened.result.current.photos.size).toBe(0);
    reopened.unmount();
  });

  it("reacquires a photo-only token after expiry in a long-lived view", async () => {
    mocks.request.mockImplementationOnce(async () => grant("first@example.com", 200))
      .mockImplementation(async () => grant("first@example.com"));
    const view = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await waitFor(() => expect(view.result.current.photos.get(guest)).toEqual(photo));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    view.unmount();
  });
});
