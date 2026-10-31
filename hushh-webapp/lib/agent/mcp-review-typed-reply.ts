/**
 * A connector write is approved only by the review card's "Allow once". A typed
 * "yes" is just another chat turn: it carries no authority, and starting a turn
 * for it would silently replace the live card. This recognises a bare yes/no
 * reply so the chat can point back at the card instead. It never approves or
 * declines anything.
 */

// Anything longer is a real instruction ("yes but only five"), not a bare reply.
const MAX_REPLY_LENGTH = 40;

const BARE_REPLIES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ya", "ok", "okay", "k", "sure", "approve",
  "approved", "go ahead", "confirm", "confirmed", "do it", "proceed", "please do",
  "yes please", "sounds good", "go for it", "allow",
  "no", "n", "nope", "nah", "cancel", "decline", "deny", "stop", "dont", "do not",
  "no thanks", "never mind", "nevermind",
]);

// Punctuation, whitespace and emoji only separate words.
const SEPARATORS = /[^\p{L}\p{N}]+/gu;
// A lone thumbs, OK-hand, check or cross (with optional skin tone) is a reply too.
const EMOJI_REPLY = /^[\s\p{P}]*(?:[\u{1F44D}\u{1F44E}\u{1F44C}\u2705\u274C]\uFE0F?\p{Emoji_Modifier}?[\s\p{P}]*)+$/u;

/** True for a short message that is only an affirmative or negative reply. */
export function isBareReviewReply(text: string): boolean {
  if (text.length > MAX_REPLY_LENGTH) return false;
  const folded = text.normalize("NFKC").toLowerCase();
  if (EMOJI_REPLY.test(folded)) return true;
  const normalized = folded
    // "don't" and "don’t" both read as "dont".
    .replace(/['\u2019]/g, "")
    .replace(SEPARATORS, " ")
    .trim();
  return BARE_REPLIES.has(normalized);
}
