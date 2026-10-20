import type { DirectoryPerson } from "@/lib/services/connections-service";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";

export type ConnectPersonIdentity = Partial<Pick<
  DirectoryPerson,
  "displayName" | "email" | "maskedEmail" | "maskedPhone"
>>;

// Both server mask formats, plus contact-only email labels in partial previews.
const CONTACT_ONLY_NAME = /^(?:\d{2}\*+\d{2}|\*{3,}\d{1,4}|[^\s@]+@[^\s@]+)$/;

/** Presentation only: the shared directory can use a contact as its missing-name fallback. */
export function connectPersonName(
  person: ConnectPersonIdentity,
  fallback = "Hussh member",
): string {
  const name = person.displayName?.trim();
  if (!name || CONTACT_ONLY_NAME.test(name)) return fallback;
  const normalizedName = name.toLowerCase();
  const isContactFallback = [person.email, person.maskedEmail, person.maskedPhone]
    .some((contact) => contact?.trim().toLowerCase() === normalizedName);
  return isContactFallback ? fallback : name;
}

/** Relationship context already available to this picker; never substitute contact details. */
export function connectPersonSelectionDetail(person: {
  connectedAt?: string | null;
  connectedFromContacts?: boolean;
  isRia?: boolean;
}): string {
  const details: string[] = [];
  const connected = formatLocalDateTime(person.connectedAt, { dateStyle: "medium", timeStyle: "short" });
  if (connected) details.push(`Connected ${connected}`);
  if (person.connectedFromContacts) details.push("From your contacts");
  if (person.isRia) details.push("Verified advisor");
  return details.join(" · ") || "Connection details unavailable";
}
