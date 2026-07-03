import type { ClientPrompt } from "@/lib/one-location/types";

/**
 * Keys that must never appear as display values in a chip label.
 * Includes identity keys (would leak user/grant IDs) and coordinate keys
 * (coordinate-free project constraint, mirrors backend _selection_display_text).
 */
const NON_DISPLAY_REF_KEYS = new Set([
  "recipientUserId",
  "recipientKeyId",
  "grantId",
  "latitude",
  "longitude",
  "coordinates",
  "lat",
  "lng",
  "lon",
  "accuracyM",
]);

function sameRef(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Human-readable, coordinate-free summary of a user's card selection, for the
 * chat chip. Resolves refs back to their option labels; falls back to option
 * *values* (never raw id or coordinate keys) so an unmatched ref can never
 * leak an id dump or a coordinate.
 */
export function describeSelection(
  prompt: ClientPrompt,
  sel: {
    selected?: Record<string, unknown>[];
    confirmed?: boolean;
    freeText?: string;
    status?: string;
  },
): string {
  if (sel.status === "cancelled") return "Cancelled";
  if (sel.freeText && sel.freeText.trim()) return sel.freeText.trim();
  if (prompt.kind === "confirm")
    return sel.confirmed ? "Confirmed" : "Declined";

  const options = prompt.options ?? [];
  const labels = (sel.selected ?? [])
    .map((ref) => {
      const match = options.find((o) => sameRef(o.ref, ref));
      if (match) return match.label;
      // No matching option: surface non-id, non-coordinate values only.
      const values = Object.entries(ref)
        .filter(([k]) => !NON_DISPLAY_REF_KEYS.has(k))
        .map(([, v]) => String(v));
      return values.join(" ");
    })
    .filter((s) => s.length > 0);

  return labels.length ? labels.join(", ") : "Your selection";
}
