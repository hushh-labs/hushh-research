import { GOOGLE_CONNECTORS, type GoogleConnector } from './connector-credential-seal';
import type { GmailAccessLevel } from './google-native-connect';

export function googleConnectorDeepLink(connector: GoogleConnector, gmailAccessLevel: GmailAccessLevel = 'read'): string {
  return `hushh://one/connect/google/${connector}${connector === 'gmail' && gmailAccessLevel === 'manage' ? '?access=manage' : ''}`;
}

export type GoogleConnectorIntent = { connector: GoogleConnector; gmailAccessLevel: GmailAccessLevel };

/** A link supplies only a connector and explicit access intent, never owner or authority. */
export function googleConnectorIntent(raw: string): GoogleConnectorIntent | null {
  try {
    const value = new URL(raw);
    if (value.protocol !== 'hushh:' || value.hostname !== 'one' || value.username ||
        value.password || value.port || value.hash) return null;
    const match = /^\/connect\/google\/(gmail|calendar|drive|contacts)$/.exec(value.pathname);
    if (!match || !GOOGLE_CONNECTORS.includes(match[1] as GoogleConnector)) return null;
    const connector = match[1] as GoogleConnector;
    const entries = [...value.searchParams.entries()];
    if (entries.length === 0) return { connector, gmailAccessLevel: 'read' };
    const entry = entries[0];
    if (connector !== 'gmail' || entries.length !== 1 || !entry || entry[0] !== 'access' ||
        !['read', 'manage'].includes(entry[1])) return null;
    return { connector, gmailAccessLevel: entry[1] as GmailAccessLevel };
  } catch { return null; }
}

/** The receiving phone still authenticates, unlocks and confirms the requested access. */
export const GOOGLE_CONNECTOR_HANDOFF_EVENT = 'hushh:google-connector-intent';
export function requestGoogleConnectorPhoneHandoff(connector: GoogleConnector, gmailAccessLevel: GmailAccessLevel = 'read'): void {
  window.dispatchEvent(new CustomEvent(GOOGLE_CONNECTOR_HANDOFF_EVENT, { detail: googleConnectorDeepLink(connector, gmailAccessLevel) }));
}
