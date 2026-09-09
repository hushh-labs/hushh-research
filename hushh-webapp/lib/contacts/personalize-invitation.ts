import type { InvitationShare } from "@/lib/services/contact-invitations-service";

/** Personalization stays on-device and is visible before the user sends. */
export function personalizeInvitation(
  share: InvitationShare,
  displayName: string,
): InvitationShare {
  const name = Array.from(
    displayName
      .replace(/\p{Cc}/gu, " ")
      .replace(/[\uD800-\uDFFF]/gu, "\uFFFD")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 80)
    .join("");
  return {
    ...share,
    text:
      name && name !== "Contact" ? `Hi ${name},\n\n${share.text}` : share.text,
  };
}
