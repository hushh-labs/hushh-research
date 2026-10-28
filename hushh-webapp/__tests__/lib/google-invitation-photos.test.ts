import { afterEach, describe, expect, it, vi } from "vitest";
import { exactInvitationEmails, lookupGoogleInvitationPhoto, photoFromExactPeople } from "@/lib/services/google-invitation-photos";
import { googlePeoplePhotoSource } from "@/lib/profile/provider-avatar";
import type { GooglePhotoGrant } from "@/lib/services/google-invitation-photo-token";

const photo = (source: string, url = "https://lh3.googleusercontent.com/-abc/s100/photo.jpg", id = source.toLowerCase()) => ({ url, default: false, metadata: { source: { type: source, id } } });
const person = (email: string, photos = [photo("CONTACT")]) => ({ resourceName: `people/${email}`, emailAddresses: [{ value: email, metadata: { source: { type: "CONTACT", id: "contact" }, verified: false } }], photos });
const grant = (accountEmail = "owner@example.com"): GooglePhotoGrant => ({ token: "browser-token", subject: "verified-subject", accountEmail, permission: "contacts", expiresAt: Date.now() + 60_000 });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("invitation-only Google photo matching", () => {
  it("uses a non-default Google profile photo but never a saved contact photo", () => {
    expect(photoFromExactPeople("guest@example.com", [{ ...person("guest@example.com", [
      photo("CONTACT", "https://lh3.googleusercontent.com/contact/s100/photo.jpg"),
      photo("PROFILE", "https://lh3.googleusercontent.com/profile/s100/photo.jpg"),
    ]), emailAddresses: [{ value: "guest@example.com", metadata: { source: { type: "PROFILE", id: "profile" }, verified: true } }] }])).toEqual({ url: "https://lh3.googleusercontent.com/profile/s100/photo.jpg", source: "google_profile" });
    expect(photoFromExactPeople("guest@example.com", [person("guest@example.com", [
      photo("PROFILE", "https://lh3.googleusercontent.com/unrelated/profile.jpg"),
      photo("CONTACT", "https://lh3.googleusercontent.com/contact/photo.jpg"),
    ])])).toBeNull();
  });

  it("does not borrow a photo from another source merged by phone", () => {
    const merged = { ...person("other@example.com", [photo("CONTACT")]), emailAddresses: [
      { value: "guest@example.com", metadata: { source: { type: "PROFILE", id: "profile" }, verified: true } },
      { value: "other@example.com", metadata: { source: { type: "CONTACT", id: "contact" }, verified: false } },
    ] };
    expect(photoFromExactPeople("guest@example.com", [merged])).toBeNull();
  });

  it("rejects missing, default, prefix-only, ambiguous and truncated matches", () => {
    expect(photoFromExactPeople("guest@example.com", [person("guest@example.com", [{ ...photo("PROFILE"), default: true }])])).toBeNull();
    expect(photoFromExactPeople("guest@example.com", [person("guest2@example.com")])).toBeNull();
    expect(photoFromExactPeople("guest@example.com", [person("guest@example.com"), person("guest@example.com")])).toBeNull();
    expect(photoFromExactPeople("guest@example.com", [person("guest@example.com")], true)).toBeNull();
    expect(photoFromExactPeople("guest@example.com", [person("guest@example.com", [photo("CONTACT", "https://evil.example/photo.jpg")])])).toBeNull();
    expect(exactInvitationEmails([" GUEST@example.com ", "guest@example.com", "not an email"])).toEqual(["guest@example.com"]);
    const omittedFalse = { ...photo("PROFILE") } as { default?: boolean; url: string; metadata: { source: { type: string; id: string } } };
    delete omittedFalse.default;
    const profilePerson = { ...person("guest@example.com", [omittedFalse]), emailAddresses: [{ value: "guest@example.com", metadata: { source: { type: "PROFILE", id: "profile" }, verified: true } }] };
    expect(photoFromExactPeople("guest@example.com", [profilePerson])).toMatchObject({ source: "google_profile" });
  });

  it("admits documented Google People URLs but rejects off-host, credentials and unsafe parameters", () => {
    expect(googlePeoplePhotoSource("https://lh3.googleusercontent.com/-abc/s100/photo.jpg?sz=50")?.href).toContain("?sz=50");
    expect(googlePeoplePhotoSource("https://lh3.googleusercontent.com/-abc/s100/photo.jpg?token=secret")).toBeNull();
    expect(googlePeoplePhotoSource("https://user@lh3.googleusercontent.com/-abc/s100/photo.jpg")).toBeNull();
    expect(googlePeoplePhotoSource("https://lh3.googleusercontent.com.evil.test/photo.jpg")).toBeNull();
  });

  it("queries only the exact guest with the browser-held token", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ results: [{ person: person("guest@example.com") }] }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(lookupGoogleInvitationPhoto(grant(), "guest@example.com", new AbortController().signal)).resolves.toBeNull();
    const [url, options] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://people.googleapis.com");
    expect(url.searchParams.get("query")).toBe("guest@example.com");
    expect(url.searchParams.get("readMask")).toBe("emailAddresses,photos,metadata");
    expect(options.headers).toEqual({ Authorization: "Bearer browser-token" });
    expect(options.cache).toBe("no-store");
  });

  it("uses a provider-returned People resource for a richer profile photo, then checks the email again", async () => {
    const saved = { ...person("guest@example.com"), resourceName: "people/c123" };
    const profile = { ...person("guest@example.com", [photo("PROFILE", "https://lh3.googleusercontent.com/profile/photo.jpg")]), emailAddresses: [{ value: "guest@example.com", metadata: { source: { type: "PROFILE", id: "profile" }, verified: true } }] };
    const fetchMock = vi.fn(async (_url: URL) => ({ ok: true, json: async () => fetchMock.mock.calls.length === 1 ? { results: [{ person: saved }] } : profile }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(lookupGoogleInvitationPhoto(grant(), "guest@example.com", new AbortController().signal)).resolves.toMatchObject({ source: "google_profile" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v1/people/c123");
  });

  it("distinguishes blocked provider access from an expired or revoked token", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(lookupGoogleInvitationPhoto(grant(), "guest@example.com", new AbortController().signal)).rejects.toThrow(/People API must be enabled/i);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(lookupGoogleInvitationPhoto(grant(), "guest@example.com", new AbortController().signal)).rejects.toThrow(/expired or was revoked/i);
  });
});
