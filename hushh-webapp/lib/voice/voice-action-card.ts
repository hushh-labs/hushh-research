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

/**
 * A destructive action, shown before it happens rather than after.
 *
 * Confirmations were removed from voice on purpose: being asked "are you sure?"
 * after saying a thing out loud is tiring, and a spoken yes adds nothing the
 * sentence did not already carry. That reasoning holds for doing things. It
 * does not hold for undoing them -- "remove Rashid" spoken once, misheard once,
 * is a connection gone with no undo.
 *
 * So this is not the old confirmation returning. It is scoped to actions whose
 * effect cannot be taken back, and it is opt-in per handler.
 *
 * Deliberately NOT gated on the contract's `risk_level`. That field marks 11
 * wired actions high, and most of them are constructive: `connect.send_request`,
 * `location.create_circle`, `location.add_emergency_contact`, and
 * `location.share_selected` -- the hands-free share flow that was explicitly
 * cleared of taps. Gating on it would put a tap back in the middle of the one
 * flow that most needed to lose it.
 */
export type VoiceConfirm = {
  /** The governed action to run if the person confirms. */
  actionId: string;
  /** Slots replayed verbatim on confirm. */
  slots: Record<string, unknown>;
  /** The question. Names the subject: "Remove your connection with Rashid?" */
  prompt: string;
  /** Who or what this acts on, rendered like a candidate row. */
  subject?: {
    name: string;
    detail?: string | null;
  } | null;
  /**
   * What the action actually does, in the person's terms. Sourced from the
   * generated contract's own `meaning`, so the warning stays true when the
   * behaviour changes instead of drifting into a comfortable fiction.
   */
  consequence?: string | null;
  /** Label for the destructive button. "Remove", "Stop sharing". */
  confirmLabel: string;
};

export type VoiceCardRequest =
  | ({ kind: "choice" } & VoiceDisambiguation)
  | ({ kind: "confirm" } & VoiceConfirm);

/** The keys a handler result carries each shape under. */
export const VOICE_DISAMBIGUATION_DATA_KEY = "disambiguation";
export const VOICE_CONFIRM_DATA_KEY = "confirm";

let current: VoiceCardRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function publishVoiceCard(next: VoiceCardRequest | null) {
  current = next;
  emit();
}

export function readVoiceCard(): VoiceCardRequest | null {
  return current;
}

export function clearVoiceCard() {
  if (current === null) return;
  current = null;
  emit();
}

export function subscribeToVoiceCard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read whichever shape a handler result carries, if either.
 *
 * Confirm is checked first. A handler that somehow emits both is asking a
 * destructive question and a "which one" question at once, and the destructive
 * one must not be the thing that gets skipped.
 */
export function parseVoiceCard(
  data: Record<string, unknown> | undefined,
): VoiceCardRequest | null {
  const confirm = parseVoiceConfirm(data);
  if (confirm) return { kind: "confirm", ...confirm };
  const choice = parseVoiceDisambiguation(data);
  if (choice) return { kind: "choice", ...choice };
  return null;
}

/**
 * Validate a confirm payload.
 *
 * A malformed one must leave the spoken answer in place rather than render a
 * dialog with no question in it -- and, more importantly, must never render a
 * destructive button whose label or subject failed to arrive.
 */
export function parseVoiceConfirm(
  data: Record<string, unknown> | undefined,
): VoiceConfirm | null {
  const raw = data?.[VOICE_CONFIRM_DATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<VoiceConfirm>;
  const actionId = String(value.actionId ?? "").trim();
  const prompt = String(value.prompt ?? "").trim();
  const confirmLabel = String(value.confirmLabel ?? "").trim();
  // No silent defaults here. An unlabelled destructive button is one someone
  // presses without knowing what it does.
  if (!actionId || !prompt || !confirmLabel) return null;

  const subjectRaw = value.subject;
  const subject =
    subjectRaw && typeof subjectRaw === "object"
      ? {
          name: String(subjectRaw.name ?? "").trim(),
          detail: subjectRaw.detail ? String(subjectRaw.detail).trim() : null,
        }
      : null;

  return {
    actionId,
    slots:
      value.slots && typeof value.slots === "object"
        ? (value.slots as Record<string, unknown>)
        : {},
    prompt,
    subject: subject && subject.name ? subject : null,
    consequence: value.consequence ? String(value.consequence).trim() : null,
    confirmLabel,
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
