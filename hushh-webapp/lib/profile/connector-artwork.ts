/** Authored vendor artwork shared by Profile, Connect, and the native asset generator.
 * Pure vector SVGs only — zero raster proxies, network lookups, or alternate icon geometry. */
export const CONNECTOR_ARTWORK = {
  gmail: { file: "gmail.svg", monochrome: false },
  google_drive: { file: "drive.svg", monochrome: false },
  calendar: { file: "calendar.svg", monochrome: false },
  contacts: { file: "contacts.svg", monochrome: false },
  stripe: { file: "stripe.svg", monochrome: false },
  plaid: { file: "plaid.svg", monochrome: true },
  attio: { file: "attio.svg", monochrome: true },
  hubspot: { file: "hubspot.svg", monochrome: false },
  notion: { file: "notion.svg", monochrome: true },
  instagram: { file: "instagram.svg", monochrome: false },
  linkedin: { file: "linkedin.svg", monochrome: false },
  github: { file: "github.svg", monochrome: true },
  slack: { file: "slack.svg", monochrome: false },
  linear: { file: "linear.svg", monochrome: true },
} as const;

export type ConnectorArtworkId = keyof typeof CONNECTOR_ARTWORK;

const CONNECTOR_ARTWORK_ALIASES: Record<string, ConnectorArtworkId> = {
  drive: "google_drive",
  google_calendar: "calendar",
  google_contacts: "contacts",
  mail: "gmail",
};

export function connectorArtworkId(id: string): ConnectorArtworkId | null {
  const normalized = String(id || "").trim().toLowerCase().replaceAll("-", "_");
  if (Object.hasOwn(CONNECTOR_ARTWORK, normalized)) {
    return normalized as ConnectorArtworkId;
  }
  return Object.hasOwn(CONNECTOR_ARTWORK_ALIASES, normalized)
    ? CONNECTOR_ARTWORK_ALIASES[normalized]!
    : null;
}

export function resolveConnectorArtwork(value: string): ConnectorArtworkId | null {
  const exact = connectorArtworkId(value);
  if (exact) return exact;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("stripe")) return "stripe";
  if (normalized.includes("github")) return "github";
  if (normalized.includes("slack")) return "slack";
  if (normalized.includes("linear")) return "linear";
  if (normalized.includes("notion")) return "notion";
  if (normalized.includes("hubspot")) return "hubspot";
  if (normalized.includes("attio")) return "attio";
  if (normalized.includes("plaid")) return "plaid";
  if (normalized.includes("instagram")) return "instagram";
  if (normalized.includes("linkedin")) return "linkedin";
  if (normalized.includes("gmail")) return "gmail";
  if (normalized.includes("drive")) return "google_drive";
  if (normalized.includes("calendar")) return "calendar";
  if (normalized.includes("contacts")) return "contacts";
  return null;
}
