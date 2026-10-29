import type { AccountEmailAlias } from "@/lib/services/account-service";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import { admittedPortraitSource } from "@/lib/profile/provider-avatar";

export type CalendarHusshPerson = {
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
};

export type CalendarHusshPeople = ReadonlyMap<string, CalendarHusshPerson>;

function exactEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && email.includes("@") ? email : null;
}

function admittedPhoto(value: string | null | undefined): string | null {
  const photo = value?.trim();
  return photo && admittedPortraitSource(photo) ? photo : null;
}

/** Known Calendar people from active Connections and the owner's proven addresses. */
export function calendarHusshPeople({
  connections, ownerId, ownerEmail, ownerEmailVerified, ownerPhotoUrl, ownerAliases = [],
}: {
  connections: readonly ConnectionSummaryEntry[];
  ownerId: string;
  ownerEmail: string | null | undefined;
  ownerEmailVerified: boolean;
  ownerPhotoUrl: string | null | undefined;
  ownerAliases?: readonly AccountEmailAlias[];
}): CalendarHusshPeople {
  const people = new Map<string, CalendarHusshPerson>();
  const ambiguous = new Set<string>();
  const add = (email: string | null | undefined, person: CalendarHusshPerson) => {
    const key = exactEmail(email);
    if (!key || ambiguous.has(key)) return;
    const prior = people.get(key);
    if (prior && prior.userId !== person.userId) {
      people.delete(key);
      ambiguous.add(key);
    } else if (!prior) {
      people.set(key, person);
    }
  };
  for (const connection of connections) {
    if (connection.emailVerified !== true || !connection.userId) continue;
    add(connection.email, {
      userId: connection.userId,
      displayName: connection.displayName?.trim() || null,
      photoUrl: admittedPhoto(connection.photoUrl),
    });
  }
  if (ownerId) {
    const owner = { userId: ownerId, displayName: null, photoUrl: admittedPhoto(ownerPhotoUrl) };
    if (ownerEmailVerified) add(ownerEmail, owner);
    for (const alias of ownerAliases) {
      if (alias.user_id === ownerId && alias.verification_status === "verified" && !alias.revoked_at) {
        add(alias.email_normalized, owner);
      }
    }
  }
  return people;
}

export function calendarHusshPerson(people: CalendarHusshPeople, email: string | null | undefined): CalendarHusshPerson | null {
  return people.get(exactEmail(email) || "") ?? null;
}

/** Keep owner-proven addresses and use fresh server matches for invitation peers. */
export function calendarEventPeople(
  known: CalendarHusshPeople,
  visible: Record<string, { userId: string; photoUrl: string }> | undefined,
  ownerId: string,
): CalendarHusshPeople {
  // Connections may retain an old email after its Firebase identity changes.
  // Invitation peers must therefore come only from the current verified lookup.
  const people = new Map([...known].filter(([, person]) => person.userId === ownerId));
  if (!visible) return people;
  for (const [address, person] of Object.entries(visible)) {
    const email = exactEmail(address);
    const photoUrl = admittedPhoto(person?.photoUrl);
    if (!email || !person?.userId || !photoUrl) continue;
    const prior = people.get(email);
    if (prior && prior.userId !== person.userId) continue;
    people.set(email, {
      userId: person.userId,
      displayName: prior?.displayName ?? null,
      photoUrl,
    });
  }
  return people;
}

export function verifiedCalendarAccountPhoto(
  account: { google_email?: string | null; google_email_verified?: boolean } | undefined,
  displayedEmail: string,
  people: CalendarHusshPeople,
): string | null {
  return account?.google_email_verified === true && account.google_email?.trim().toLowerCase() === displayedEmail.trim().toLowerCase()
    ? calendarHusshPerson(people, displayedEmail)?.photoUrl ?? null
    : null;
}
