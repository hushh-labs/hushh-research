import { Capacitor } from "@capacitor/core";
import {
  HushhInvitations,
  type SmsComposeOutcome,
} from "@/lib/capacitor/invitations";
import {
  normalizeInviteEmail,
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
    if (!/^\+[1-9]\d{6,14}$/.test(destination.value))
      throw new Error("Choose a valid phone number.");
    // Number-only is supported by Apple's documented SMS URL contract.
    return `sms:${destination.value}`;
  }
  const email = normalizeInviteEmail(destination.value);
  if (!email) throw new Error("Choose a valid email address.");
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(share.title)}&body=${encodeURIComponent(invitationBody(share))}`;
}

/** Owns platform handoff. No recipients are sent to any Hushh endpoint. */
export const ContactInvitationsService = {
  isNative: () => Capacitor.isNativePlatform(),
  async canComposeSms(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      return (await HushhInvitations.getCapabilities()).sms;
    } catch {
      return false;
    } // Older native builds retain share/copy.
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
  share(share: InvitationShare): Promise<ShareDelivery> {
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
      return ContactInvitationsService.copy(share);
    }
    return shareLink(share);
  },
  async copy(share: InvitationShare): Promise<"copied"> {
    assertInvitationShare(share);
    if (!(await copyToClipboard(invitationBody(share))))
      throw new Error("Could not copy the invitation.");
    return "copied";
  },
};
