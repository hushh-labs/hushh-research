/**
 * The candidates One is stuck between, and the seam that shows them.
 *
 * Every voice resolver already refused an ambiguous name the same way:
 *
 *   "More than one person matches that name: Ankit Kumar Singh, Ankit Kumar
 *    Singh. Say which one."
 *
 * That is answerable when the names differ. It is a hard dead end when they do
 * not -- and two accounts sharing a display name is the ordinary case, not the
 * edge one. There is no utterance that separates them, so the person is asked
 * for something they cannot give and the request is simply lost. Naming the
 * candidates was already an improvement over "be more specific"; it just cannot
 * reach the case where the names ARE the answer.
 *
 * What distinguishes those accounts is never the name -- it is the handle
 * beside it. So the resolution has to be shown, not spoken. A handler that
 * cannot pick returns its candidates in `data.disambiguation`, the runtime
 * publishes them here, and the agent bar renders one row each: name, the
 * distinguishing detail underneath, and the action's own button on the right.
 *
 * `detail` is deliberately not called `email`. Contact sync will make it a
 * phone number for some people and an email for others, and the row should not
 * have to change shape when it does.
 *
 * This is a client-side store on purpose. Choosing between two people the
 * person can already see is not a trust decision: the action still runs through
 * the same governed handler with the same policy checks, so nothing here mints
 * a directive, touches the ledger, or widens what voice is allowed to do. It
 * only replaces a question that could not be answered with a list that can be.
 */

export type VoiceDisambiguationCandidate = {
  /** Stable identity the action re-runs against. Never spoken, never shown. */
  id: string;
  /** What the person hears and reads. Shared across candidates by definition. */
  name: string;
  /**
   * The distinguishing line under the name -- a masked email today, a phone
   * number once contact sync lands. Absent when the surface has nothing to
   * tell two records apart, which is worth showing as its own state rather
   * than rendering a blank row.
   */
  detail?: string | null;
  /**
   * Per-candidate button label. Two rows with the same name can still be in
   * different relationship states -- one connectable, one with a request
   * already pending -- so a single fixed label would offer at least one person
   * an action that is guaranteed to fail.
   */
  actionLabel: string;
  /**
   * Set when this candidate cannot be acted on at all. The row still renders,
   * because seeing why a duplicate is unavailable is the information the
   * person needs; it just cannot be tapped.
   */
  disabledReason?: string | null;
};

export type VoiceDisambiguation = {
  /** The governed action to re-run once a candidate is chosen. */
  actionId: string;
  /** Slot name carrying the chosen identity, e.g. "userId". */
  resolveSlot: string;
  /** Slots to replay unchanged alongside the resolved identity. */
  slots: Record<string, unknown>;
  /** One short line above the list. */
  prompt: string;
  candidates: VoiceDisambiguationCandidate[];
};

/** The key a handler result carries its candidates under. */
export const VOICE_DISAMBIGUATION_DATA_KEY = "disambiguation";

let current: VoiceDisambiguation | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function publishVoiceDisambiguation(next: VoiceDisambiguation | null) {
  current = next;
  emit();
}

export function readVoiceDisambiguation(): VoiceDisambiguation | null {
  return current;
}

export function clearVoiceDisambiguation() {
  if (current === null) return;
  current = null;
  emit();
}

export function subscribeToVoiceDisambiguation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read a disambiguation out of a handler result's `data`, if it carries one.
 *
 * Validated rather than trusted: a malformed payload must leave the normal
 * spoken refusal in place instead of rendering an empty card, which would be a
 * worse dead end than the one being fixed -- the person would see a list with
 * nothing in it and no sentence explaining why.
 */
export function parseVoiceDisambiguation(
  data: Record<string, unknown> | undefined,
): VoiceDisambiguation | null {
  const raw = data?.[VOICE_DISAMBIGUATION_DATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<VoiceDisambiguation>;
  const actionId = String(value.actionId ?? "").trim();
  const resolveSlot = String(value.resolveSlot ?? "").trim();
  if (!actionId || !resolveSlot) return null;
  if (!Array.isArray(value.candidates)) return null;

  const candidates = value.candidates
    .filter((candidate): candidate is VoiceDisambiguationCandidate =>
      Boolean(candidate && typeof candidate === "object"),
    )
    .map((candidate) => ({
      id: String(candidate.id ?? "").trim(),
      name: String(candidate.name ?? "").trim() || "Someone",
      detail: candidate.detail ? String(candidate.detail).trim() : null,
      actionLabel: String(candidate.actionLabel ?? "").trim() || "Choose",
      disabledReason: candidate.disabledReason
        ? String(candidate.disabledReason).trim()
        : null,
    }))
    .filter((candidate) => candidate.id.length > 0);

  // One candidate is not a choice, and zero is not a card. Both mean the
  // resolver should have answered rather than asked.
  if (candidates.length < 2) return null;

  return {
    actionId,
    resolveSlot,
    slots:
      value.slots && typeof value.slots === "object"
        ? (value.slots as Record<string, unknown>)
        : {},
    prompt: String(value.prompt ?? "").trim() || "Which one did you mean?",
    candidates,
  };
}
