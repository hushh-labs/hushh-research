import { Capacitor } from "@capacitor/core";
import {
  HushhInvitations,
  type SmsComposeOutcome,
} from "@/lib/capacitor/invitations";
import {
  normalizeInviteEmail,
  isInvitePhone,
  MAX_INVITATION_RECIPIENTS,
  type InviteDestination,
} from "@/lib/contacts/invitation-candidates";
import { shareLink, type ShareDelivery } from "@/lib/share/share-link";
import { copyToClipboard } from "@/lib/utils/clipboard";

export type InvitationShare = {
  title: string;
  text: string;
  url: string;
  dialogTitle: string;
};
export type InvitationOutcome =
  | SmsComposeOutcome
  | ShareDelivery
  | "launch_requested";

export function invitationBody(share: InvitationShare): string {
  return `${share.text}\n${share.url}`;
}

export function assertInvitationShare(share: InvitationShare): void {
  const url = new URL(share.url);
  if (!/^https?:$/.test(url.protocol) || invitationBody(share).length > 2000) {
    throw new Error("This invitation link is unavailable.");
  }
}

export function invitationComposeUrl(
  destination: InviteDestination,
  share: InvitationShare,
): string {
  assertInvitationShare(share);
  if (destination.kind === "phone") {
    if (!isInvitePhone(destination.value))
      throw new Error("Choose a valid phone number.");
    // Number-only is supported by Apple's documented SMS URL contract.
    return `sms:${destination.value}`;
  }
  const email = normalizeInviteEmail(destination.value);
  if (!email) throw new Error("Choose a valid mail address.");
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(share.title)}&body=${encodeURIComponent(invitationBody(share))}`;
}

/** Validate the entire reviewed batch before any external handoff. */
export function invitationBatchDestinations(
  destinations: InviteDestination[],
  kind: InviteDestination["kind"],
): string[] {
  if (!destinations.length || destinations.length > MAX_INVITATION_RECIPIENTS)
    throw new Error(
      `Choose between 1 and ${MAX_INVITATION_RECIPIENTS} contacts.`,
    );
  const values = destinations.map((destination) => {
    if (destination.kind !== kind)
      throw new Error("Choose contacts for this app.");
    const value =
      kind === "email"
        ? normalizeInviteEmail(destination.value)
        : isInvitePhone(destination.value)
          ? destination.value
          : null;
    if (!value) throw new Error("Choose a valid contact destination.");
    return value;
  });
  // Case variants of a mailbox must not create two invitations to the same person.
  if (
    new Set(values.map((value) => value.toLowerCase())).size !== values.length
  )
    throw new Error("Choose each destination only once.");
  return values;
}

export function invitationBatchEmailUrl(
  destinations: InviteDestination[],
  share: InvitationShare,
): string {
  assertInvitationShare(share);
  if (/[\r\n\x00]/.test(share.title))
    throw new Error("Invalid invitation subject.");
  const recipients = invitationBatchDestinations(destinations, "email");
  // RFC 6068 mailbox-list: only BCC contains recipients; never expose them in To/CC.
  const bcc = recipients.map(encodeURIComponent).join(",");
  const body = invitationBody(share).replace(/\r?\n/g, "\r\n");
  const url = `mailto:?bcc=${bcc}&subject=${encodeURIComponent(share.title)}&body=${encodeURIComponent(body)}`;
  // Mail handlers have differing URL limits. Fail explicitly rather than truncate a batch.
  if (url.length > 8000)
    throw new Error(
      "This email draft is too long. Select fewer contacts or copy the invitation.",
    );
  return url;
}

/** Owns platform handoff. No recipients are sent to any Hushh endpoint. */
export const ContactInvitationsService = {
  isNative: () => Capacitor.isNativePlatform(),
  // Android share completion can mean only that a target was opened (or the
  // chooser closed). Keep that recipient until the person confirms completion.
  completesRecipient: (outcome: InvitationOutcome) =>
    outcome === "queued_or_sent" ||
    outcome === "web-share" ||
    (outcome === "native-share" && Capacitor.getPlatform() === "ios"),
  async canComposeSms(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      return (await HushhInvitations.getCapabilities()).sms;
    } catch {
      return false;
    } // Older native builds retain share/copy.
  },
  async canComposeBatchSms(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      const capabilities = await HushhInvitations.getCapabilities();
      return (
        capabilities.sms === true &&
        Number.isInteger(capabilities.maxSmsRecipients) &&
        (capabilities.maxSmsRecipients ?? 0) >= MAX_INVITATION_RECIPIENTS
      );
    } catch {
      return false;
    }
  },
  async composeBatch(
    destinations: InviteDestination[],
    share: InvitationShare,
    isCurrentSession: () => boolean = () => true,
  ): Promise<InvitationOutcome> {
    if (!isCurrentSession()) return "cancelled";
    assertInvitationShare(share);
    if (Capacitor.isNativePlatform()) {
      const recipients = invitationBatchDestinations(destinations, "phone");
      const body = invitationBody(share);
      if (!(await ContactInvitationsService.canComposeBatchSms()))
        return "unavailable";
      // A capability probe can outlive Close, logout or navigation. Recheck
      // before disclosing the reviewed recipients to the external composer.
      if (!isCurrentSession()) return "cancelled";
      try {
        return (
          await HushhInvitations.composeSmsBatch({
            recipients,
            body,
          })
        ).outcome;
      } catch {
        return "unavailable";
      }
    }
    // No await before the browser launch: retain the user's activation.
    window.location.href = invitationBatchEmailUrl(destinations, share);
    return "launch_requested";
  },
  async compose(
    destination: InviteDestination,
    share: InvitationShare,
  ): Promise<InvitationOutcome> {
    const url = invitationComposeUrl(destination, share);
    if (destination.kind === "phone" && Capacitor.isNativePlatform()) {
      try {
        return (
          await HushhInvitations.composeSms({
            recipient: destination.value,
            body: invitationBody(share),
          })
        ).outcome;
      } catch {
        return "unavailable";
      }
    }
    // Invoke synchronously on the user's tap. A launch is not proof of opening/sending.
    window.location.href = url;
    return "launch_requested";
  },
  share(
    share: InvitationShare,
    isCurrentSession: () => boolean = () => true,
  ): Promise<ShareDelivery> {
    if (!isCurrentSession())
      return Promise.reject(new DOMException("Share cancelled", "AbortError"));
    assertInvitationShare(share);
    if (!Capacitor.isNativePlatform()) {
      // Keep Web Share on the original tap, without a lazy native import first.
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function"
      ) {
        return navigator
          .share({ title: share.title, text: share.text, url: share.url })
          .then(() => "web-share" as const);
      }
      return ContactInvitationsService.copy(share, isCurrentSession);
    }
    return shareLink(share, isCurrentSession);
  },
  async copy(
    share: InvitationShare,
    isCurrentSession: () => boolean = () => true,
  ): Promise<"copied"> {
    if (!isCurrentSession())
      throw new DOMException("Share cancelled", "AbortError");
    assertInvitationShare(share);
    if (!(await copyToClipboard(invitationBody(share), isCurrentSession)))
      throw new Error("Could not copy the invitation.");
    return "copied";
  },
};
