/** Older place responses combine the venue name and street address in one label. */
export function splitCheckInPlaceLabel(label: string): {
  name: string;
  address: string | null;
} {
  const separator = label.indexOf(",");
  if (separator < 0) return { name: label.trim(), address: null };
  return {
    name: label.slice(0, separator).trim(),
    address: label.slice(separator + 1).trim() || null,
  };
}
