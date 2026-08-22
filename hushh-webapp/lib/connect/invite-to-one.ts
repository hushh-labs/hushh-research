import { resolveShareableAppOrigin } from "@/lib/share/app-origin";

/**
 * Inviting somebody who is not on One yet.
 *
 * Connect searches the One directory. Search a name that is not in it and the
 * screen says "No one matches" and stops -- correct, and a dead end, because
 * the single most likely reason a name is missing is that the person has not
 * joined. The directory has no answer for that; the answer is outside the app.
 *
 * What is shared is deliberately just the app: no invite token, no pending
 * connection, no code. Nobody is added to anything by receiving this, and the
 * sender is not committed to anything by sending it. A recipient who taps it
 * lands on the same anonymous onboarding entry as any other first-time visitor
 * and decides for themselves; if they join, they are found by the next search
 * and connected through the normal request flow, which is where consent is
 * asked for and recorded. An invite that pre-authorized a connection would be
 * asking one person to consent on another person's behalf.
 */

/** The share sheet's own title -- what the sender sees while choosing an app. */
export const INVITE_TO_ONE_DIALOG_TITLE = "Invite to One";

/**
 * The message the recipient reads.
 *
 * Read in a chat thread, where the sender's name and photo are already on
 * screen, so the copy does not introduce the sender -- that would be the one
 * line the recipient does not need. It says what is being asked and nothing
 * more. The link is not repeated here: most share targets (WhatsApp, Messages)
 * append `url` to `text`, and a link written into both is delivered twice.
 */
export const INVITE_TO_ONE_SHARE_TEXT = "Join me on One so we can connect.";

/** What the sheet calls the thing being shared, where a target shows a title. */
export const INVITE_TO_ONE_SHARE_TITLE = "Join me on One";

/**
 * The invite link, or null when this build cannot produce one a recipient
 * could open.
 *
 * Null is not a failure to report: it means the app has no shareable origin --
 * a native build with no `NEXT_PUBLIC_APP_URL` baked in -- and an invite whose
 * link is dead is worse than no invite at all, so the caller simply does not
 * offer one. See `lib/share/app-origin.ts` for why a device's own origin is
 * never usable here.
 */
export function buildInviteToOneUrl(): string | null {
  const origin = resolveShareableAppOrigin();
  return origin ? `${origin}/` : null;
}

/**
 * The full payload for `shareLink`, or null when there is no link to send.
 *
 * Returned as one object so the row that offers the invite and the handler
 * that sends it agree on whether an invite exists -- checking the origin twice
 * is how a button that cannot work gets rendered.
 */
export function buildInviteToOneShare(): {
  title: string;
  text: string;
  dialogTitle: string;
  url: string;
} | null {
  const url = buildInviteToOneUrl();
  if (!url) return null;
  return {
    title: INVITE_TO_ONE_SHARE_TITLE,
    text: INVITE_TO_ONE_SHARE_TEXT,
    dialogTitle: INVITE_TO_ONE_DIALOG_TITLE,
    url,
  };
}
