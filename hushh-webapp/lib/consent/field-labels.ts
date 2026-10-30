/**
 * Fixed human names for field keys ("fein" is "Federal EIN").
 *
 * The TypeScript half of `known_field_label` in
 * `consent-protocol/hushh_mcp/consent/field_labels.py`, reading the same table,
 * `contracts/consent/field-labels.v1.json` (mirrored under
 * `hushh-webapp/contracts/consent/`), so a field the device withholds from the
 * model is named the way the server would name it.
 */

import contract from "@/contracts/consent/field-labels.v1.json";

const KEY_LABELS: Readonly<Record<string, string>> = contract.key_labels;

/** The fixed human name for a field key, or null when the key is not listed. */
export function knownFieldLabel(key: string | null | undefined): string | null {
  const normalized = String(key ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return null;
  if (Object.prototype.hasOwnProperty.call(KEY_LABELS, normalized)) return KEY_LABELS[normalized]!;
  // "entity_fein" names the same field as "fein" under its parent's word.
  const split = normalized.indexOf("_");
  if (split <= 0) return null;
  const rest = normalized.slice(split + 1);
  return rest && Object.prototype.hasOwnProperty.call(KEY_LABELS, rest) ? KEY_LABELS[rest]! : null;
}
