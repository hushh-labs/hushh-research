import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import { googleAvatarSource } from "@/lib/profile/provider-avatar";

export type InvitationPerson = { displayName: string | null; photoUrl: string | null };

/** Only a unique, exact email match may enrich a Calendar person. */
export function connectedInvitationPeople(connections: readonly ConnectionSummaryEntry[]): ReadonlyMap<string, InvitationPerson> {
  const people = new Map<string, InvitationPerson>();
  const ambiguous = new Set<string>();
  for (const connection of connections) {
    const email = connection.email?.trim().toLowerCase();
    if (!email || ambiguous.has(email)) continue;
    if (people.has(email)) {
      people.delete(email);
      ambiguous.add(email);
      continue;
    }
    people.set(email, {
      displayName: connection.displayName?.trim() || null,
      photoUrl: connection.photoUrl?.trim() || null,
    });
  }
  return people;
}

/** Keep the selected Calendar account's photo bound to its own attendee email. */
export function invitationPhotoUrl(
  people: ReadonlyMap<string, InvitationPerson>,
  email: string | null | undefined,
  accountEmail: string | null | undefined,
  accountPhotoUrl: string | null | undefined,
): string | null {
  const key = email?.trim().toLowerCase();
  if (!key) return null;
  if (key === accountEmail?.trim().toLowerCase() && accountPhotoUrl) {
    const accountPhoto = googleAvatarSource(accountPhotoUrl)?.href;
    if (accountPhoto) return accountPhoto;
  }
  return people.get(key)?.photoUrl ?? null;
}
