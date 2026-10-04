"use client";

/**
 * The owner's standing style settings: how One writes to them, never what One
 * may do.
 *
 * They live in the reserved `identity.communication_preferences` branch of the
 * owner's encrypted memory and are edited only in Settings (Profile >
 * Preferences). Each chat turn reads them from the decrypted working set and
 * sends them as their own `communicationPreferences` request field; the
 * recalled-memory packet no longer carries the branch, so the same values are
 * never presented to One as both data and style.
 *
 * The shape is closed and mirrors the server's
 * `consent-protocol/hushh_mcp/one_adk/owner_style.py`, which refuses anything
 * outside it. Chat can only propose a change (the `propose_style_settings`
 * offer card); the proposal is handed to Settings in memory, never in the URL,
 * and the owner commits it there with `saveOwnerStyleSettings`
 * (`owner-style-settings-writer.ts`). This module stays pure so the chat
 * client can import it without the PKM write path.
 */
import { containsSecretSpan } from "@/lib/pkm/secret-patterns";

export const OWNER_STYLE_DOMAIN = "identity" as const;
export const OWNER_STYLE_BRANCH = "communication_preferences" as const;
/** The Settings writer's identity in PKM receipts and the reserved-branch registry. */
export const OWNER_STYLE_SETTINGS_SOURCE = "one_settings_communication_preferences" as const;

export const PREFERRED_NAME_MAX = 64;
export const STYLE_NOTE_MAX = 280;

export const OWNER_STYLE_TONES = ["direct", "warm", "casual", "formal", "executive"] as const;
export const OWNER_STYLE_LENGTHS = ["short", "balanced", "detailed"] as const;
export const OWNER_STYLE_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "nl", "hi", "zh", "ja", "ko", "ar",
] as const;

export type OwnerStyleTone = (typeof OWNER_STYLE_TONES)[number];
export type OwnerStyleLength = (typeof OWNER_STYLE_LENGTHS)[number];
export type OwnerStyleLanguage = (typeof OWNER_STYLE_LANGUAGES)[number];

/** The closed request shape. An absent key means "no preference". */
export type OwnerStyleSettings = {
  preferred_name?: string;
  tone?: OwnerStyleTone;
  length?: OwnerStyleLength;
  language?: OwnerStyleLanguage;
  avoid_em_dashes?: boolean;
  owner_style_note?: string;
};

/** What chat may propose. The style note is editable only in Settings. */
export type OwnerStyleProposal = Omit<OwnerStyleSettings, "owner_style_note">;

export const OWNER_STYLE_TONE_LABEL: Record<OwnerStyleTone, string> = {
  direct: "Direct",
  warm: "Warm",
  casual: "Casual",
  formal: "Formal",
  executive: "Executive",
};
export const OWNER_STYLE_LENGTH_LABEL: Record<OwnerStyleLength, string> = {
  short: "Short",
  balanced: "Balanced",
  detailed: "Detailed",
};
export const OWNER_STYLE_LANGUAGE_LABEL: Record<OwnerStyleLanguage, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  hi: "Hindi",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/**
 * One paragraph of printable text: control and format characters removed and
 * whitespace collapsed. The server applies the same rule.
 */
export function sanitizeStyleText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/gu, (character) => (/\s/.test(character) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizeStyleText(value);
  return clean && clean.length <= max ? clean : undefined;
}

/**
 * Onboarding wrote a sentence (`reply_style`) before the closed schema
 * existed. Read it as the nearest enums so a saved choice keeps working.
 */
const LEGACY_REPLY_STYLE: Record<string, Pick<OwnerStyleSettings, "tone" | "length">> = {
  "Short and direct replies": { tone: "direct", length: "short" },
  "Detailed replies": { length: "detailed" },
  "Casual, conversational replies": { tone: "casual" },
};

/**
 * The closed settings from the stored branch. Unknown keys are dropped and
 * out-of-range values are treated as unset, so a stale or hand-edited branch
 * can never make the server refuse a chat turn.
 */
export function ownerStyleFromBranch(raw: unknown): OwnerStyleSettings {
  const branch = asRecord(raw);
  if (!branch) return {};
  const legacy = typeof branch.reply_style === "string" ? LEGACY_REPLY_STYLE[branch.reply_style] : undefined;
  const settings: OwnerStyleSettings = {};
  const name = boundedText(branch.preferred_name, PREFERRED_NAME_MAX);
  if (name) settings.preferred_name = name;
  const tone = isOneOf(OWNER_STYLE_TONES, branch.tone) ? branch.tone : legacy?.tone;
  if (tone) settings.tone = tone;
  const length = isOneOf(OWNER_STYLE_LENGTHS, branch.length) ? branch.length : legacy?.length;
  if (length) settings.length = length;
  if (isOneOf(OWNER_STYLE_LANGUAGES, branch.language)) settings.language = branch.language;
  if (typeof branch.avoid_em_dashes === "boolean") settings.avoid_em_dashes = branch.avoid_em_dashes;
  const note = boundedText(branch.owner_style_note, STYLE_NOTE_MAX);
  if (note) settings.owner_style_note = note;
  return settings;
}

/**
 * The request field, or undefined when nothing is set. The style text goes into
 * One's prompt verbatim, so a name or note that holds a secret (Secrets:
 * never sent to a model) is left out of the turn; Settings still shows it.
 */
export function ownerStyleRequestField(settings: OwnerStyleSettings | null | undefined): OwnerStyleSettings | undefined {
  const clean = ownerStyleFromBranch(settings);
  if (containsSecretSpan(clean.preferred_name)) delete clean.preferred_name;
  if (containsSecretSpan(clean.owner_style_note)) delete clean.owner_style_note;
  return Object.keys(clean).length ? clean : undefined;
}

/** A chat proposal from an untrusted tool result: closed, and never the note. */
export function parseOwnerStyleProposal(raw: unknown): OwnerStyleProposal | null {
  const { owner_style_note: _note, ...proposal } = ownerStyleFromBranch(asRecord(raw));
  return Object.keys(proposal).length ? proposal : null;
}

/**
 * Write the owner's choices into the branch. Settings is the only caller: an
 * explicit owner save, encrypted on device, with the coordinator's version
 * guard. Replaces the branch's style keys and drops the legacy sentence.
 */
export function mergeOwnerStyleSettings(
  currentDomainData: Record<string, unknown> | null | undefined,
  settings: OwnerStyleSettings,
  savedAt: string,
): Record<string, unknown> {
  const current = asRecord(currentDomainData) ?? {};
  return {
    ...current,
    [OWNER_STYLE_BRANCH]: { ...ownerStyleFromBranch(settings), updated_at: savedAt },
  };
}

/** Owner-facing rows for a proposal, in the order Settings shows them. */
export function describeOwnerStyleProposal(proposal: OwnerStyleProposal): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (proposal.preferred_name) rows.push({ label: "Call me", value: proposal.preferred_name });
  if (proposal.tone) rows.push({ label: "Tone", value: OWNER_STYLE_TONE_LABEL[proposal.tone] });
  if (proposal.length) rows.push({ label: "Length", value: OWNER_STYLE_LENGTH_LABEL[proposal.length] });
  if (proposal.language) rows.push({ label: "Language", value: OWNER_STYLE_LANGUAGE_LABEL[proposal.language] });
  if (typeof proposal.avoid_em_dashes === "boolean") {
    rows.push({ label: "Avoid em dashes", value: proposal.avoid_em_dashes ? "On" : "Off" });
  }
  return rows;
}

// --- Chat to Settings handoff, in memory only ---------------------------------

const PROPOSAL_TTL_MS = 10 * 60 * 1000;
/** Fired when a proposal is staged; it carries no values, only the nudge. */
export const OWNER_STYLE_PROPOSAL_EVENT = "hushh:owner-style-proposal";
let stagedProposal: { ownerUserId: string; proposal: OwnerStyleProposal; expiresAt: number } | null = null;

/** Hold a chat proposal for the owner's next Settings visit in this tab. */
export function stageOwnerStyleProposal(ownerUserId: string, proposal: OwnerStyleProposal): void {
  stagedProposal = { ownerUserId, proposal: { ...proposal }, expiresAt: Date.now() + PROPOSAL_TTL_MS };
  // Settings may already be on screen (the profile pane beside chat).
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OWNER_STYLE_PROPOSAL_EVENT));
}

/** Take the staged proposal once; another owner or an expired one gets nothing. */
export function takeOwnerStyleProposal(ownerUserId: string): OwnerStyleProposal | null {
  const staged = stagedProposal;
  stagedProposal = null;
  if (!staged || staged.ownerUserId !== ownerUserId || staged.expiresAt <= Date.now()) return null;
  return staged.proposal;
}
