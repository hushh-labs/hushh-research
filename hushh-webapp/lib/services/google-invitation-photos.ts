/** Invitation-only People reads. No contact list, token, or photo is sent to Hussh. */
import { googlePeoplePhotoSource } from "@/lib/profile/provider-avatar";
import type { GooglePhotoGrant } from "./google-invitation-photo-token";

export type GoogleInvitationPhoto = {
  url: string;
  source: "google_profile" | "google_contact" | "workspace_profile" | "workspace_contact";
};

type FieldSource = { type?: string; id?: string };
type FieldMetadata = { verified?: boolean; source?: FieldSource };
type Person = {
  resourceName?: string;
  emailAddresses?: { value?: string; metadata?: FieldMetadata }[];
  photos?: { url?: string; default?: boolean; metadata?: FieldMetadata }[];
};
type ContactsResponse = { results?: { person?: Person }[] };
type DirectoryResponse = { people?: Person[]; nextPageToken?: string };
const PERSON_FIELDS = "emailAddresses,photos,metadata";
const MAX_CONTACT_RESULTS = 30;
const MAX_DIRECTORY_PAGES = 2;
export const MAX_INVITATION_PHOTO_GUESTS = 40;

export class GooglePhotoProviderError extends Error {
  constructor(readonly kind: "revoked" | "provider_blocked", permission: GooglePhotoGrant["permission"]) {
    super(kind === "revoked" ? "Google photo permission expired or was revoked. Calendar still works."
      : permission === "directory" ? "Google blocked Workspace directory photos. The People API and Workspace administrator directory sharing and app policy must allow access. Calendar still works."
      : "Google blocked Contacts photos. The People API must be enabled and this OAuth app approved for Contacts access. Calendar still works.");
  }
}

export function exactInvitationEmails(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].map(value => value?.trim().toLowerCase() || "").filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))].slice(0, MAX_INVITATION_PHOTO_GUESTS);
}

/** A prefix search result is never trusted until a unique exact email is found. */
export function photoFromExactPeople(email: string, people: readonly Person[], truncated = false): GoogleInvitationPhoto | null {
  if (truncated) return null;
  const target = email.trim().toLowerCase();
  const matches = people.filter(person => person.emailAddresses?.some(address => address.value?.trim().toLowerCase() === target));
  if (matches.length !== 1) return null;
  const matched = matches[0]!;
  const exactFields = (matched.emailAddresses || []).filter(address => address.value?.trim().toLowerCase() === target);
  // People may merge unrelated source records by phone. A photo must share a
  // provider source ID with the exact attendee email, not merely a Person.
  // Google JSON may omit a false proto boolean; only an explicit default=true
  // is the provider's generic avatar.
  const photos = (matched.photos || []).filter(photo => photo.default !== true && photo.url);
  const ranked = photos.map(photo => {
    const type = photo.metadata?.source?.type;
    const sourceId = photo.metadata?.source?.id;
    const matchingEmail = Boolean(sourceId && exactFields.some(address =>
      address.metadata?.source?.type === type && address.metadata?.source?.id === sourceId &&
      (!["PROFILE", "ACCOUNT", "DOMAIN_PROFILE"].includes(type || "") || address.metadata?.verified === true)));
    const source = !matchingEmail ? null
      : type === "PROFILE" || type === "ACCOUNT" ? "google_profile"
      : type === "DOMAIN_PROFILE" ? "workspace_profile"
      : type === "CONTACT" ? "google_contact"
      : type === "DOMAIN_CONTACT" ? "workspace_contact" : null;
    const url = googlePeoplePhotoSource(photo.url || "")?.href;
    return source && url ? { url, source } as GoogleInvitationPhoto : null;
  }).filter((value): value is GoogleInvitationPhoto => value !== null);
  const priority = ["google_profile", "workspace_profile", "google_contact", "workspace_contact"];
  return ranked.sort((left, right) => priority.indexOf(left.source) - priority.indexOf(right.source))[0] || null;
}

function uniqueExactPerson(email: string, people: readonly Person[], truncated = false): Person | null {
  if (truncated) return null;
  const matches = people.filter(person => person.emailAddresses?.some(address => address.value?.trim().toLowerCase() === email));
  return matches.length === 1 ? matches[0]! : null;
}

async function googleJson<T>(url: URL, grant: GooglePhotoGrant, signal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) throw new DOMException("Photo lookup cancelled.", "AbortError");
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${grant.token}` },
      cache: "no-store", signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) throw new GooglePhotoProviderError("revoked", grant.permission);
      if (response.status === 403) throw new GooglePhotoProviderError("provider_blocked", grant.permission);
      throw new Error("Google photos could not be loaded.");
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export async function warmGoogleContactsPhotoSearch(grant: GooglePhotoGrant, signal: AbortSignal): Promise<void> {
  if (grant.permission !== "contacts") return;
  const url = new URL("https://people.googleapis.com/v1/people:searchContacts");
  url.searchParams.set("query", "");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("readMask", PERSON_FIELDS);
  url.searchParams.append("sources", "READ_SOURCE_TYPE_CONTACT");
  url.searchParams.append("sources", "READ_SOURCE_TYPE_PROFILE");
  await googleJson<ContactsResponse>(url, grant, signal);
  // Google's documented search cache warms asynchronously.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 5_000);
    const abort = () => { clearTimeout(timer); reject(new DOMException("Photo lookup cancelled.", "AbortError")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function lookupGoogleInvitationPhoto(grant: GooglePhotoGrant, email: string, signal: AbortSignal): Promise<GoogleInvitationPhoto | null> {
  if (grant.expiresAt <= Date.now() || signal.aborted) return null;
  const normalized = exactInvitationEmails([email])[0];
  if (!normalized) return null;
  if (grant.permission === "contacts") {
    const url = new URL("https://people.googleapis.com/v1/people:searchContacts");
    url.searchParams.set("query", normalized);
    url.searchParams.set("pageSize", String(MAX_CONTACT_RESULTS));
    url.searchParams.set("readMask", PERSON_FIELDS);
    url.searchParams.append("sources", "READ_SOURCE_TYPE_CONTACT");
    url.searchParams.append("sources", "READ_SOURCE_TYPE_PROFILE");
    const result = await googleJson<ContactsResponse>(url, grant, signal);
    const people = (result.results || []).map(item => item.person).filter((person): person is Person => Boolean(person));
    const matched = uniqueExactPerson(normalized, people, people.length >= MAX_CONTACT_RESULTS);
    if (!matched) return null;
    const searchPhoto = photoFromExactPeople(normalized, [matched]);
    // A resourceName returned by People is provider data. Never construct one
    // from the email or assume Calendar's optional legacy Profile ID is this ID.
    if (/^people\/[A-Za-z0-9_-]+$/.test(matched.resourceName || "")) {
      const detail = new URL(`https://people.googleapis.com/v1/${matched.resourceName}`);
      detail.searchParams.set("personFields", PERSON_FIELDS);
      detail.searchParams.append("sources", "READ_SOURCE_TYPE_CONTACT");
      detail.searchParams.append("sources", "READ_SOURCE_TYPE_PROFILE");
      try {
        const profile = await googleJson<Person>(detail, grant, signal);
        if (uniqueExactPerson(normalized, [profile])) {
          const fullPhoto = photoFromExactPeople(normalized, [profile]);
          if (fullPhoto?.source === "google_profile") return fullPhoto;
          return fullPhoto || searchPhoto;
        }
      } catch (error) {
        if (error instanceof GooglePhotoProviderError) throw error;
      }
    }
    return searchPhoto;
  }
  // Directory access is domain limited. Never query an external guest with it.
  const domain = grant.hostedDomain;
  if (!domain || normalized.split("@")[1] !== domain) return null;
  const url = new URL("https://people.googleapis.com/v1/people:searchDirectoryPeople");
  url.searchParams.set("query", normalized);
  url.searchParams.set("readMask", PERSON_FIELDS);
  url.searchParams.set("pageSize", "100");
  url.searchParams.append("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE");
  url.searchParams.append("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT");
  const people: Person[] = [];
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page += 1) {
    const result = await googleJson<DirectoryResponse>(url, grant, signal);
    people.push(...(result.people || []));
    if (!result.nextPageToken) return photoFromExactPeople(normalized, people);
    url.searchParams.set("pageToken", result.nextPageToken);
  }
  return null;
}
