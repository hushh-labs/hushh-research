import type { DirectoryPerson } from "@/lib/services/connections-service";

/**
 * Every field optional, because this now captions two different records.
 *
 * Directory rows carry all four; a connection summary carries the masked pair
 * and no raw `email`. Requiring the full set meant the caption a connection
 * could perfectly well produce was unavailable to anything holding one, which
 * is how the voice card ended up saying "No other details" beside a list that
 * was captioning the same people correctly.
 */
type DirectoryPersonIdentity = Partial<
  Pick<DirectoryPerson, "displayName" | "email" | "maskedEmail" | "maskedPhone">
>;

/** Accept only the server's national first-two/last-two privacy projection. */
export function getDirectoryPersonMaskedPhone(
  person: DirectoryPersonIdentity,
): string | undefined {
  const mask = person.maskedPhone?.trim();
  return mask && /^\d{2}\*+\d{2}$/.test(mask) ? mask : undefined;
}

/**
 * The one contact line a directory row may show: an email the server returned
 * for this viewer (already masked when it is not theirs to see). Never a phone
 * number and never a phone fallback; a row with no email shows no line.
 */
export function getDirectoryPersonEmail(
  person: DirectoryPersonIdentity,
): string | undefined {
  return person.email?.trim() || person.maskedEmail?.trim() || undefined;
}

export function getDirectoryPersonDescription(
  person: DirectoryPersonIdentity,
): string | undefined {
  if (!person.displayName) return undefined;
  return person.email || person.maskedEmail || getDirectoryPersonMaskedPhone(person);
}
