/** Authored vendor artwork shared by Profile and the native asset generator.
 * No network lookup, executable URL or alternate icon geometry. */
export const CONNECTOR_ARTWORK = {
  gmail: { file: "gmail.svg", monochrome: false },
  google_drive: { file: "drive.svg", monochrome: false },
  calendar: { file: "calendar.svg", monochrome: false },
  plaid: { file: "plaid.svg", monochrome: true },
  attio: { file: "attio.svg", monochrome: true },
  hubspot: { file: "hubspot.svg", monochrome: false },
  notion: { file: "notion.svg", monochrome: true },
  instagram: { file: "instagram-reference.jpg", monochrome: false, crop: { left: 1144, top: 245, width: 590, height: 590 } },
  linkedin: { file: "linkedin.png", monochrome: false },
} as const;
export type ConnectorArtworkId = keyof typeof CONNECTOR_ARTWORK;
export function connectorArtworkId(id: string): ConnectorArtworkId | null {
  return Object.hasOwn(CONNECTOR_ARTWORK, id) ? id as ConnectorArtworkId : null;
}
