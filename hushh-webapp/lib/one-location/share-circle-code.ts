import {
  isShareCancellationError as isShareCancelled,
  shareLink,
  type ShareDelivery,
} from "@/lib/share/share-link";

/** Kept as an alias so existing imports read unchanged. */
export type CircleCodeShareDelivery = ShareDelivery;

/** Re-exported: cancelling a share is not a failure, and every caller here
 *  already checks it under this name. */
export const isShareCancellationError = isShareCancelled;

/**
 * How a Circle is named inside share copy ("Join my <label> on One …").
 *
 * The copy appends the word "Circle" so a bare name like "K Family" reads as a
 * group. Names that already end in "Circle" — every default onboarding name is
 * `<First>'s Circle` — would otherwise be delivered as "JHUMMA's Circle Circle",
 * so the suffix is only added when the name does not already carry it.
 */
export function circleShareLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Circle";
  return /\bcircles?$/i.test(trimmed) ? trimmed : `${trimmed} Circle`;
}

/**
 * The message that goes out with a Circle invite.
 *
 * This is read in a chat thread, not in the product, so it carries the two
 * things the recipient cannot get anywhere else -- whose Circle it is and the
 * code -- and nothing else. The earlier copy also explained what tapping the
 * link would do, how to find the join screen by hand, and what stays private;
 * all three are answered by the join screen itself the moment the link opens,
 * so in the message they were three sentences nobody needed to read.
 *
 * The code stays in the text even alongside a link, because share targets that
 * drop the `url` field would otherwise deliver an invite with no way to join.
 * Without a link the message has to say where the code goes, since there is
 * nothing to tap.
 */
export function buildCircleInviteShareText(params: {
  circleLabel: string;
  code: string;
  hasJoinLink: boolean;
}): string {
  const opening = `Join my ${params.circleLabel} on One.`;
  return params.hasJoinLink
    ? `${opening} Code ${params.code}`
    : `${opening} Enter code ${params.code} under Location → People.`;
}

/**
 * Share a short-lived Circle invite. When a `url` is supplied it is the ONLY
 * place the join link appears: most share targets (WhatsApp, Messages) append
 * `url` to `text`, so a link repeated inside `text` is delivered twice. Callers
 * therefore keep `text` link-free and let it carry the human-safe consent
 * explanation plus the raw code — which is what targets that ignore the url
 * field fall back to, since the code alone is enough to join.
 *
 * Capacitor owns the native iOS/Android sheet; browsers use Web Share and then
 * the shared clipboard fallback.
 */
export async function shareNamedCircleCode(params: {
  title: string;
  text: string;
  dialogTitle: string;
  url?: string;
}): Promise<CircleCodeShareDelivery> {
  return shareLink(params);
}
