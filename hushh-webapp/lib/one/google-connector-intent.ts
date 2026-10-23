import { GOOGLE_CONNECTORS, type GoogleConnector } from './connector-credential-seal';

/** A link is only a requested capability. It never supplies an owner, pod or secret. */
export function googleConnectorIntent(raw: string): GoogleConnector | null {
  return parseGoogleConnectorIntent(raw)?.connector ?? null;
}

export function parseGoogleConnectorIntent(raw: string): { connector: GoogleConnector; addMailbox: boolean } | null {
  try {
    const value = new URL(raw);
    if (value.protocol !== 'hushh:' || value.hostname !== 'one' || value.username ||
        value.password || value.port || value.search || value.hash) return null;
    const match = /^\/connect\/google\/(gmail|calendar|drive|contacts)(\/add)?$/.exec(value.pathname);
    return match && GOOGLE_CONNECTORS.includes(match[1] as GoogleConnector) && (!match[2] || match[1] === 'gmail') ? { connector: match[1] as GoogleConnector, addMailbox: !!match[2] } : null;
  } catch { return null; }
}

/** In-app web handoff event carries the same closed connector intent as a QR. */
export const GOOGLE_CONNECTOR_HANDOFF_EVENT = 'hushh:google-connector-intent';
export function requestGoogleConnectorPhoneHandoff(connector: GoogleConnector, addMailbox = false): void {
  window.dispatchEvent(new CustomEvent(GOOGLE_CONNECTOR_HANDOFF_EVENT, { detail: `hushh://one/connect/google/${connector}${connector === 'gmail' && addMailbox ? '/add' : ''}` }));
}
