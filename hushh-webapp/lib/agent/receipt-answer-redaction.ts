/** Retiring a receipt turn's private answer from the chat. */
import { RECEIPT_SETUP_EXPERIENCE_TYPE } from "./mail-chat-experiences";

export const RECEIPT_ANSWER_REDACTED_TEXT = "Receipt analysis was shown for that turn. Ask again for a fresh analysis.";
export const RECEIPT_ANSWER_UNFINISHED_TEXT = "Receipt analysis ended before it was shown. Ask again.";
const STOPPED_TEXTS = new Set(["Stopped.", "Agent turn canceled."]);
const RECEIPT_SETUP_ID = ":receipt-setup";

type Entry = { id: string; experience: unknown };
type ReceiptTurnMessage = {
  text: string;
  status?: "streaming" | "done" | "error";
  errorNotice?: string;
  receiptRedacted?: boolean;
  structuredExperience?: unknown;
  structuredExperiences?: Entry[];
  streamEvents?: unknown[];
  sources?: unknown[];
  followUps?: string[];
};

/** The receipt sync state a setup card shows, or null for the Connect Gmail card and other cards. */
function setupState(entry: Entry): string | null {
  const experience = entry.experience as { type?: unknown; state?: unknown } | null;
  return experience?.type === RECEIPT_SETUP_EXPERIENCE_TYPE && typeof experience.state === "string" ? experience.state : null;
}

/** A stopped or canceled turn drops a "Syncing receipts…" card that will never finish. */
export function withoutSyncingReceiptCard<E extends Entry>(entries: readonly E[] | undefined): E[] {
  return (entries ?? []).filter(entry => !entry.id.endsWith(RECEIPT_SETUP_ID) || setupState(entry) !== "syncing");
}

/**
 * Strips the private content of a receipt turn and keeps its setup card (it
 * holds no receipt values). Only a finished turn that answered from receipt
 * values says the analysis "was shown": a failed turn keeps its error (its error
 * text replaces a partial answer), a stopped one keeps "Stopped.", and a turn
 * still running, or one whose receipts were unavailable, says it ended first.
 * Status never changes here; see retireReceiptAnswer for the stored form.
 */
export function redactReceiptAnswer<T extends ReceiptTurnMessage>(message: T): T {
  const cards = withoutSyncingReceiptCard(message.structuredExperiences).filter(entry => entry.id.endsWith(RECEIPT_SETUP_ID));
  const unavailable = cards.some(entry => setupState(entry) === "sync_required" || setupState(entry) === null);
  const text = message.status === "error" ? message.errorNotice ?? message.text
    : message.status === "done" && STOPPED_TEXTS.has(message.text) ? message.text
      : message.status === "done" && !unavailable ? RECEIPT_ANSWER_REDACTED_TEXT : RECEIPT_ANSWER_UNFINISHED_TEXT;
  return {
    ...message, text, receiptRedacted: true, errorNotice: undefined,
    structuredExperience: null, structuredExperiences: cards, streamEvents: [], sources: [], followUps: [],
  };
}

/**
 * The stored form of a retired receipt answer. A redacted message takes no
 * later updates, so a turn still running is settled now; otherwise it would
 * stream forever with its timer running and its real outcome never shown.
 */
export function retireReceiptAnswer<T extends ReceiptTurnMessage & { receiptPrivate?: unknown }>(message: T): T {
  return { ...redactReceiptAnswer(message), receiptPrivate: undefined, status: message.status === "streaming" ? "done" : message.status };
}
