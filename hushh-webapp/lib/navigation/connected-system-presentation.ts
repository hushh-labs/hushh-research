/**
 * Route-local, public CRM presentation state for the shared app shell.
 *
 * The registry response arrives inside the detail surface after the shell has
 * rendered. A tiny in-memory publication channel lets the shell replace its
 * neutral fallback crumb without persisting any protected CRM record data.
 */
const CONNECTED_SYSTEM_PRESENTATION_EVENT =
  "hushh:connected-system-presentation";

export type ConnectedSystemPresentation = {
  systemId: string;
  label: string;
};

const labelsBySystemId = new Map<string, string>();

function cleanPresentation(
  presentation: ConnectedSystemPresentation,
): ConnectedSystemPresentation | null {
  const systemId = presentation.systemId.trim();
  const label = presentation.label.trim();
  return systemId && label ? { systemId, label } : null;
}

export function publishConnectedSystemPresentation(
  presentation: ConnectedSystemPresentation,
) {
  const cleaned = cleanPresentation(presentation);
  if (!cleaned) return;

  labelsBySystemId.set(cleaned.systemId, cleaned.label);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ConnectedSystemPresentation>(
        CONNECTED_SYSTEM_PRESENTATION_EVENT,
        { detail: cleaned },
      ),
    );
  }
}

export function getConnectedSystemPresentationLabel(systemId?: string | null) {
  const cleanedSystemId = String(systemId || "").trim();
  return cleanedSystemId
    ? (labelsBySystemId.get(cleanedSystemId) ?? null)
    : null;
}

export function subscribeConnectedSystemPresentation(
  listener: (presentation: ConnectedSystemPresentation) => void,
) {
  if (typeof window === "undefined") return () => undefined;

  const onPresentation = (event: Event) => {
    const presentation = cleanPresentation(
      (event as CustomEvent<ConnectedSystemPresentation>).detail,
    );
    if (presentation) listener(presentation);
  };
  window.addEventListener(CONNECTED_SYSTEM_PRESENTATION_EVENT, onPresentation);
  return () =>
    window.removeEventListener(
      CONNECTED_SYSTEM_PRESENTATION_EVENT,
      onPresentation,
    );
}
