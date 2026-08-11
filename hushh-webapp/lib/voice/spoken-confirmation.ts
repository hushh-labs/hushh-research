/**
 * Reading a yes or a no out of what the person actually said.
 *
 * When One asks "share your location with Sarah for an hour?", something has
 * to decide whether the next thing out of their mouth was consent. That
 * decision is the whole security property of a hands-free confirmation, so
 * this module exists to keep it in three specific places it would otherwise
 * not be:
 *
 * - **In the browser, not the model.** The model is the thing being
 *   authorized. If it also reports whether you agreed, it is witnessing its
 *   own authorization. The transport already delivers `transcript_final` --
 *   the person's real words -- so the app can read the answer itself and the
 *   model never gets to claim a yes that was not said.
 * - **In a pure function, not in a component.** Every case below is a
 *   sentence someone can actually say, and getting one wrong runs an action
 *   nobody approved. That deserves tests, which means it cannot live inside
 *   an event handler.
 * - **Biased toward doing nothing.** There are three outcomes, not two.
 *   Anything that is not clearly an answer returns `unclear`, which leaves
 *   the card exactly as it was. The cost of `unclear` is that the person
 *   repeats themselves; the cost of a wrong `affirm` is an irreversible
 *   action. Those are not comparable, and the code should not treat them as
 *   though they were.
 */

export type SpokenConfirmation = "affirm" | "decline" | "unclear";

/**
 * An answer to a yes/no question is short. This is the single most important
 * guard here: without it, "yes, I told Sarah I'd be there by six" reads as
 * consent to whatever card happens to be open. Anything longer than a brief
 * reply is treated as a new request rather than an answer, because that is
 * almost always what it is.
 */
const MAX_ANSWER_WORDS = 6;

/**
 * Whole-utterance affirmatives. Deliberately not a list of words that may
 * appear anywhere: "yes" inside a longer sentence is usually narration, not
 * consent, and the length guard above is what separates the two.
 */
const AFFIRMATIVES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "yes please",
  "please do",
  "please",
  "ok",
  "okay",
  "okay do it",
  "sure",
  "sure thing",
  "go ahead",
  "go for it",
  "do it",
  "do that",
  "confirm",
  "confirmed",
  "approve",
  "approved",
  "send it",
  "share it",
  "correct",
  "right",
  "that's right",
  "affirmative",
]);

const DECLINES = new Set([
  "no",
  "nope",
  "nah",
  "no thanks",
  "no thank you",
  "don't",
  "do not",
  "dont",
  "stop",
  "cancel",
  "cancel it",
  "cancel that",
  "never mind",
  "nevermind",
  "forget it",
  "not now",
  "not yet",
  "wait",
  "hold on",
  "negative",
  "abort",
]);

/**
 * Words that turn an apparent yes into something that is not a yes.
 *
 * "yes but not Sarah" and "yes, wait" both contain an affirmative and both
 * mean stop. A hedge anywhere in a short reply is enough to withhold consent,
 * because a genuine yes rarely needs one.
 */
const HEDGES = [
  "but",
  "wait",
  "actually",
  "instead",
  "except",
  "hold on",
  "hang on",
  "not ",
];

function normalize(transcript: string): string {
  return String(transcript || "")
    .toLowerCase()
    // Punctuation carries no meaning in a spoken yes, and speech engines are
    // inconsistent about emitting it: "yes." and "yes" must not diverge.
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What the person's reply means for a confirmation that is waiting.
 *
 * Returns `unclear` for anything that is not unmistakably one or the other,
 * including silence, chatter, and a new request. Callers must treat `unclear`
 * as "leave everything alone" rather than as a soft no -- cancelling on an
 * ambiguous noise is its own kind of wrong.
 */
export function classifySpokenConfirmation(
  transcript: string,
): SpokenConfirmation {
  const text = normalize(transcript);
  if (!text) return "unclear";

  const words = text.split(" ");
  if (words.length > MAX_ANSWER_WORDS) {
    // Long enough to be a new instruction. Whatever it contains, it is not an
    // answer to a yes/no question.
    return "unclear";
  }

  // A decline is checked first and wins outright. "no, go ahead" is a
  // contradiction, and the safe reading of a contradiction is to not act.
  if (DECLINES.has(text)) return "decline";
  const startsWithDecline = words[0] === "no" || words[0] === "nope" || words[0] === "don't" || words[0] === "dont";
  if (startsWithDecline) return "decline";

  if (AFFIRMATIVES.has(text)) return "affirm";

  // A qualified yes is not a yes, whatever else the sentence contains.
  if (HEDGES.some((hedge) => text.includes(hedge))) return "unclear";

  // "sure go ahead" is agreement twice over, but it is not one phrase and its
  // words are not individually affirmative -- "go" and "ahead" mean nothing
  // alone. So the reply is consumed phrase by phrase, longest first, and only
  // counts as consent when affirmatives account for ALL of it. Anything left
  // over ("yes Sarah", "yes four hours") is a correction or a clarification,
  // and neither is an answer to what was asked.
  return consumedEntirelyByAffirmatives(words) ? "affirm" : "unclear";
}

/** True when `words` is nothing but affirmative phrases, back to back. */
function consumedEntirelyByAffirmatives(words: string[]): boolean {
  const maxPhraseWords = 3;
  let index = 0;
  let matchedSomething = false;
  while (index < words.length) {
    let matched = 0;
    // Longest first, so "go ahead" is never mistaken for a bare "go".
    for (let size = Math.min(maxPhraseWords, words.length - index); size >= 1; size -= 1) {
      const phrase = words.slice(index, index + size).join(" ");
      if (AFFIRMATIVES.has(phrase)) {
        matched = size;
        break;
      }
    }
    if (!matched) return false;
    matchedSomething = true;
    index += matched;
  }
  return matchedSomething;
}
