/** Invocation-local information. Never serialize into sync results or telemetry. */
export type InviteDestination = { kind: "phone" | "email"; value: string };
export type InviteCandidate = {
  id: string;
  displayName: string;
  destinations: InviteDestination[];
  classification: "no_match" | "email_only";
};

export type LocalInviteContact = Omit<InviteCandidate, "classification"> & {
  /** True only when the source contained no phone entries, not invalid phones. */
  emailOnly: boolean;
};

export function contactInvitationsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED !== "false";
}

export function normalizeInviteEmail(input: string): string | null {
  const value = input.trim();
  // A destination is one mailbox, never a mailto header or recipient list.
  if (value.length > 254 || /[\s\x00-\x1f\x7f,;<>?&#%]/.test(value))
    return null;
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(value)) return null;
  const at = value.lastIndexOf("@");
  const mailbox = value.slice(0, at);
  const domain = value.slice(at + 1);
  // Support unquoted mailboxes, including international letters. Do not admit
  // comments, empty dot-atoms or URL path/port syntax as a mail destination.
  if (
    mailbox.length > 64 ||
    !/^[\p{L}\p{M}\p{N}!$'*+\-/=^_`{|}~.]+$/u.test(mailbox) ||
    mailbox.startsWith(".") ||
    mailbox.endsWith(".") ||
    mailbox.includes("..") ||
    /[/:\\\[\]]/.test(domain)
  )
    return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${domain}`).hostname;
  } catch {
    return null;
  }
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    ) ||
    !/[a-z]/i.test(labels.at(-1)!) ||
    `${mailbox}@${hostname}`.length > 254
  )
    return null;
  return `${mailbox}@${hostname}`;
}

export function destinationKey(destination: InviteDestination): string {
  return `${destination.kind}:${destination.value}`;
}
