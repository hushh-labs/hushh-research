import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetGoogleInvitationPhotoGrant, useGoogleInvitationPhotos } from "@/lib/calendar/use-google-invitation-photos";
import type { GooglePhotoGrant } from "@/lib/services/google-invitation-photo-token";
import { GooglePhotoProviderError } from "@/lib/services/google-invitation-photos";

const mocks = vi.hoisted(() => ({
  request: vi.fn(), lookup: vi.fn(), warm: vi.fn(async () => undefined),
}));
vi.mock("@/lib/services/google-invitation-photo-token", () => ({
  googleInvitationPhotosAvailable: () => true,
  preloadGoogleInvitationPhotoAuth: async () => undefined,
  isGoogleContactsConsentCancelled: () => false,
  requestGoogleInvitationPhotoGrant: mocks.request,
}));
vi.mock("@/lib/services/google-invitation-photos", async importOriginal => ({
  ...(await importOriginal<object>()),
  lookupGoogleInvitationPhoto: mocks.lookup,
  warmGoogleContactsPhotoSearch: mocks.warm,
}));

const guest = "guest@example.com";
const photo = { url: "https://lh3.googleusercontent.com/-guest/photo.jpg", source: "google_profile" as const };
const account = (accountId: string) => ({
  enabled: true, ownerId: "owner", accountId, accountEmail: `${accountId}@example.com`,
  subjectSha256: "a".repeat(64), grantGeneration: `${accountId}-generation`,
  grantedScopes: "https://www.googleapis.com/auth/calendar.readonly", guestEmails: [guest],
});
afterEach(() => { forgetGoogleInvitationPhotoGrant(); vi.clearAllMocks(); });

describe("invitation photo account isolation", () => {
  it("reuses only the selected account's valid in-memory grant after a tab remount", async () => {
    mocks.request.mockImplementation(async (email: string) => ({ token: `${email}-token`, accountEmail: email, subject: email,
      hostedDomain: null, permission: "contacts", expiresAt: Date.now() + 60_000 } satisfies GooglePhotoGrant));
    mocks.lookup.mockResolvedValue(photo);
    const first = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await act(async () => { await first.result.current.authorize("contacts"); });
    await waitFor(() => expect(first.result.current.photos.get(guest)).toEqual(photo));
    first.unmount();

    const reopened = renderHook(() => useGoogleInvitationPhotos(account("first")));
    expect(reopened.result.current.permission).toBe("contacts");
    await waitFor(() => expect(reopened.result.current.photos.get(guest)).toEqual(photo));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    reopened.unmount();

    const other = renderHook(() => useGoogleInvitationPhotos(account("second")));
    expect(other.result.current.permission).toBeNull();
    expect(other.result.current.photos.size).toBe(0);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    other.unmount();

    const previous = renderHook(() => useGoogleInvitationPhotos(account("first")));
    expect(previous.result.current.permission).toBeNull();
    previous.unmount();
  });

  it("does not reuse a photo grant after the Calendar grant generation changes", async () => {
    mocks.request.mockImplementation(async (email: string) => ({ token: "photo-only", accountEmail: email, subject: email,
      hostedDomain: null, permission: "contacts", expiresAt: Date.now() + 60_000 } satisfies GooglePhotoGrant));
    mocks.lookup.mockResolvedValue(photo);
    const first = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await act(async () => { await first.result.current.authorize("contacts"); });
    await waitFor(() => expect(first.result.current.photos.get(guest)).toEqual(photo));
    first.unmount();
    const changed = renderHook(() => useGoogleInvitationPhotos({ ...account("first"), grantGeneration: "rotated" }));
    expect(changed.result.current.permission).toBeNull();
    expect(changed.result.current.photos.size).toBe(0);
    changed.unmount();
  });

  it("forgets a retained grant after Google revokes it on a reopened tab", async () => {
    mocks.request.mockImplementation(async (email: string) => ({ token: "photo-only", accountEmail: email, subject: email,
      hostedDomain: null, permission: "contacts", expiresAt: Date.now() + 60_000 } satisfies GooglePhotoGrant));
    mocks.lookup.mockResolvedValueOnce(photo).mockRejectedValue(new GooglePhotoProviderError("revoked", "contacts"));
    const first = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await act(async () => { await first.result.current.authorize("contacts"); });
    await waitFor(() => expect(first.result.current.photos.get(guest)).toEqual(photo));
    first.unmount();

    const reopened = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await waitFor(() => expect(reopened.result.current.message).toMatch(/revoked/i));
    expect(reopened.result.current.photos.size).toBe(0);
    reopened.unmount();

    const afterRevocation = renderHook(() => useGoogleInvitationPhotos(account("first")));
    expect(afterRevocation.result.current.permission).toBeNull();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    afterRevocation.unmount();
  });

  it("expires a retained grant even while Invitations is unmounted", async () => {
    mocks.request.mockImplementation(async (email: string) => ({ token: "photo-only", accountEmail: email, subject: email,
      hostedDomain: null, permission: "contacts", expiresAt: Date.now() + 1_000 } satisfies GooglePhotoGrant));
    mocks.lookup.mockResolvedValue(photo);
    const first = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await act(async () => { await first.result.current.authorize("contacts"); });
    await waitFor(() => expect(first.result.current.photos.get(guest)).toEqual(photo));
    first.unmount();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const reopened = renderHook(() => useGoogleInvitationPhotos(account("first")));
    expect(reopened.result.current.permission).toBeNull();
    expect(reopened.result.current.photos.size).toBe(0);
    reopened.unmount();
  });

  it("discards an old account's late photo and only displays a fresh grant's result", async () => {
    let resolveOld: ((value: typeof photo) => void) | undefined;
    const oldLookup = new Promise<typeof photo>(resolve => { resolveOld = resolve; });
    mocks.request.mockImplementation(async (email: string) => ({ token: `${email}-token`, accountEmail: email, subject: email, hostedDomain: null, permission: "contacts", expiresAt: Date.now() + 60_000 } satisfies GooglePhotoGrant));
    mocks.lookup.mockImplementation((grant: GooglePhotoGrant) => grant.accountEmail.startsWith("first") ? oldLookup : Promise.resolve(photo));
    const view = renderHook(({ accountId }) => useGoogleInvitationPhotos(account(accountId)), { initialProps: { accountId: "first" } });
    await act(async () => { await view.result.current.authorize("contacts"); });
    await waitFor(() => expect(mocks.lookup).toHaveBeenCalledTimes(1));
    view.rerender({ accountId: "second" });
    expect(view.result.current.photos.size).toBe(0);
    await act(async () => { resolveOld?.(photo); await oldLookup; });
    expect(view.result.current.photos.size).toBe(0);
    await act(async () => { await view.result.current.authorize("contacts"); });
    await waitFor(() => expect(view.result.current.photos.get(guest)).toEqual(photo));
    view.unmount();
  });

  it("keeps a valid grant without another prompt and removes its photos at expiry", async () => {
    mocks.request.mockImplementation(async (email: string) => ({ token: "photo-only", accountEmail: email, subject: email,
      hostedDomain: null, permission: "contacts", expiresAt: Date.now() + 500 } satisfies GooglePhotoGrant));
    mocks.lookup.mockResolvedValue(photo);
    const view = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await act(async () => { await view.result.current.authorize("contacts"); });
    await waitFor(() => expect(view.result.current.photos.get(guest)).toEqual(photo));
    view.rerender();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.result.current.photos.size).toBe(0), { timeout: 2_000 });
    expect(view.result.current.permission).toBeNull();
    expect(view.result.current.message).toMatch(/expired/i);
    view.unmount();
  });

  it("drops an authorized photo when Google revokes the read grant", async () => {
    mocks.request.mockImplementation(async (email: string) => ({ token: "photo-only", accountEmail: email, subject: email,
      hostedDomain: null, permission: "contacts", expiresAt: Date.now() + 60_000 } satisfies GooglePhotoGrant));
    mocks.lookup.mockRejectedValue(new GooglePhotoProviderError("revoked", "contacts"));
    const view = renderHook(() => useGoogleInvitationPhotos(account("first")));
    await act(async () => { await view.result.current.authorize("contacts"); });
    await waitFor(() => expect(view.result.current.message).toMatch(/revoked/i));
    expect(view.result.current.photos.size).toBe(0);
    expect(view.result.current.permission).toBeNull();
    view.unmount();
  });
});
