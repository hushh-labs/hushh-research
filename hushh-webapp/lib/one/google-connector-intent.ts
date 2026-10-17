import { GOOGLE_CONNECTORS, type GoogleConnector } from './connector-credential-seal';

/** A link is only a requested capability. It never supplies an owner, pod or secret. */
export function googleConnectorIntent(raw: string): GoogleConnector | null {
  try {
    const value = new URL(raw);
    if (value.protocol !== 'hushh:' || value.hostname !== 'one' || value.username ||
        value.password || value.port || value.search || value.hash) return null;
    const match = /^\/connect\/google\/(gmail|calendar|drive|contacts)$/.exec(value.pathname);
    return match && GOOGLE_CONNECTORS.includes(match[1] as GoogleConnector) ? match[1] as GoogleConnector : null;
  } catch { return null; }
}

/** In-app web handoff event carries the same closed connector intent as a QR. */
export const GOOGLE_CONNECTOR_HANDOFF_EVENT = 'hushh:google-connector-intent';
export function requestGoogleConnectorPhoneHandoff(connector: GoogleConnector): void {
  window.dispatchEvent(new CustomEvent(GOOGLE_CONNECTOR_HANDOFF_EVENT, { detail: `hushh://one/connect/google/${connector}` }));
}
