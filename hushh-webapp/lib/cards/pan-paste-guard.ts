/**
 * Pre-model paste guard for payment-card secrets. Pure module.
 *
 * Runs in the chat input BEFORE any network call: a message that appears to
 * contain a full card number must never reach /api/one/agent-chat, the model,
 * history, logs, or telemetry. Shared with the secure add-card form.
 *
 * Heuristic: any 13-19 digit run (spaces/dashes tolerated) that passes Luhn is
 * treated as a likely PAN. Phone numbers and order ids fall outside the length
 * window or fail the checksum.
 */

import { luhnValid } from "./card-validation";

const CANDIDATE_RUN = /(?:\d[ -]?){13,19}/g;

export function detectLikelyPan(text: string): boolean {
  const value = String(text ?? "");
  if (!value) return false;
  const matches = value.match(CANDIDATE_RUN);
  if (!matches) return false;
  for (const match of matches) {
    const digits = match.replace(/[\s-]/g, "");
    // A long digit run can embed a PAN at any offset; slide the window.
    for (let length = 19; length >= 13; length -= 1) {
      for (let start = 0; start + length <= digits.length; start += 1) {
        if (luhnValid(digits.slice(start, start + length))) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Redact likely PAN runs, keeping the last four digits for orientation. */
export function redactLikelyPans(text: string): string {
  return String(text ?? "").replace(CANDIDATE_RUN, (match) => {
    const digits = match.replace(/[\s-]/g, "");
    let isPan = false;
    for (let length = 19; length >= 13 && !isPan; length -= 1) {
      for (let start = 0; start + length <= digits.length; start += 1) {
        if (luhnValid(digits.slice(start, start + length))) {
          isPan = true;
          break;
        }
      }
    }
    if (!isPan) return match;
    return `•••• ${digits.slice(-4)}`;
  });
}
