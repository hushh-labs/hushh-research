import type { DirectoryPerson } from "@/lib/services/connections-service";

type DirectoryPersonIdentity = Pick<
  DirectoryPerson,
  "displayName" | "email" | "maskedEmail" | "maskedPhone"
>;

export function getDirectoryPersonDescription(
  person: DirectoryPersonIdentity,
): string | undefined {
  if (!person.displayName) return undefined;
  return person.email || person.maskedEmail || person.maskedPhone || undefined;
}
