import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";

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
