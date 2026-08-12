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

export function getDirectoryPersonDescription(
  person: DirectoryPersonIdentity,
): string | undefined {
  if (!person.displayName) return undefined;
  return person.email || person.maskedEmail || person.maskedPhone || undefined;
}
