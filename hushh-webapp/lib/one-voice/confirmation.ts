/**
 * Confirmation helpers for One Live Voice.
 *
 * The server decides what a pending action needs (tier, receipt, sign-in
 * proof); this module only reads that decision off the wire and the published
 * tool catalog so the control can label its affordances. Nothing here decides
 * from speech: `cancelWords` exists so the Stop affordance can tell the person
 * what they may say, and the relay is the only thing that interprets it.
 */

import catalog from "@/contracts/kai/one-voice-live-tools.v1.json";
import type { PendingActionPublic } from "@/lib/one-voice/protocol";

type CatalogTool = {
  name: string;
  tier?: "voice" | "tap" | null;
  firebase_plane?: boolean;
  policy?: string | null;
};

/** Words the relay treats as a cancel while a card is open. Label only. */
export const cancelWords: readonly string[] = Object.freeze([
  "no",
  "stop",
  "cancel",
  "wait",
]);

/** The hint under a card's Stop control; never a decision input. */
export function stopAffordanceLabel(): string {
  const spoken = cancelWords.map((word) => `"${word}"`).join(", ");
  return `Tap Stop, or say ${spoken}.`;
}

const TOOLS_BY_NAME: ReadonlyMap<string, CatalogTool> = new Map(
  ((catalog as { tools?: CatalogTool[] }).tools ?? []).map((tool) => [
    tool.name,
    tool,
  ]),
);

/** The catalog tier of a tool, or null when the tool is not in the catalog. */
export function toolTier(
  tool: string | null | undefined,
): "voice" | "tap" | null {
  const entry = TOOLS_BY_NAME.get(String(tool || ""));
  return entry?.tier === "tap" || entry?.tier === "voice" ? entry.tier : null;
}

/**
 * Tools whose execution needs a Firebase sign-in proof (the Profile and
 * Connect planes). A tap-confirm for these carries the Firebase id token.
 */
export function isFirebasePlaneTool(tool: string | null | undefined): boolean {
  return TOOLS_BY_NAME.get(String(tool || ""))?.firebase_plane === true;
}

export type PendingTapInput = Pick<PendingActionPublic, "tier" | "tool"> & {
  requiresTap?: boolean;
};

/**
 * Whether the card needs a tap to proceed. The wire flag wins; the tier and
 * the catalog are the fallbacks for a row that arrived without it (a resumed
 * session lists open actions without `requires_tap`).
 */
export function requiresTap(
  pending: PendingTapInput | null | undefined,
): boolean {
  if (!pending) return false;
  if (pending.requiresTap === true) return true;
  if (pending.tier === "tap") return true;
  return toolTier(pending.tool) === "tap";
}

/** A tap-tier card can be confirmed only while its receipt is on this device. */
export function canConfirmByTap(
  pending:
    | (PendingTapInput & {
        receiptToken?: string | null;
        resolvedStatus?: string | null;
      })
    | null
    | undefined,
): boolean {
  if (!pending) return false;
  if (pending.resolvedStatus) return false;
  if (!requiresTap(pending)) return true;
  return (
    typeof pending.receiptToken === "string" && pending.receiptToken.length > 0
  );
}
