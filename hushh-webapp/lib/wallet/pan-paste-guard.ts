/**
 * Pre-model paste guard for payment-card secrets. Pure module.
 *
 * Runs in the chat input BEFORE any network call: a message that appears to
 * contain a full card number must never reach /api/one/agent-chat, the model,
 * history, logs, or telemetry. Shared with the secure add-card form.
 *
 * Heuristic: a MAXIMAL digit run (spaces/dashes tolerated) of PAN length
 * (13-19) that passes Luhn as a whole is treated as a likely PAN. Judging the
 * whole run, rather than sliding a window inside it, is deliberate: a random
 * 16-digit order id has about a 1-in-10 chance of containing SOME Luhn-valid
 * window, which made the windowed version block ordinary ids.
 */

import { luhnValid } from "./card-validation";

const DIGIT_RUN = /\d(?:[ -]?\d)*/g;

function isLikelyPanRun(run: string): boolean {
  const digits = run.replace(/[\s-]/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

export function detectLikelyPan(text: string): boolean {
  const value = String(text ?? "");
  if (!value) return false;
  const matches = value.match(DIGIT_RUN);
  if (!matches) return false;
  return matches.some(isLikelyPanRun);
}

/** Redact likely PAN runs, keeping the last four digits for orientation. */
export function redactLikelyPans(text: string): string {
  return String(text ?? "").replace(DIGIT_RUN, (match) => {
    if (!isLikelyPanRun(match)) return match;
    const digits = match.replace(/[\s-]/g, "");
    return `•••• ${digits.slice(-4)}`;
  });
}

/** How many likely card numbers a text carries; pairs with redactLikelyPans for the memory-import lane. */
export function countLikelyPans(text: string): number {
  const matches = String(text ?? "").match(DIGIT_RUN);
  if (!matches) return 0;
  return matches.filter(isLikelyPanRun).length;
}
