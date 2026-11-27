import { flushSync } from "react-dom";
import { nativeDrawers, nativeDrawerAcknowledged, nativeWorkspaceRetirementBarrier } from "./native-drawers";
import { interfacePresentationSnapshot, setInterfaceApplying } from "./native-interface-revision";
import { acknowledgeNativeInterface, customNativePresentationEnabled, liveInterfaceSwitchAvailable } from "./native-presentation-policy";
import { nativeDocumentId } from "./session-privacy";

/** Restart only presentation. The WebView, URL, auth and vault stay mounted. */
export async function applySavedNativeInterface(enabled: boolean): Promise<boolean> {
  if (!liveInterfaceSwitchAvailable()) return false;
  const documentId = nativeDocumentId();
  if (interfacePresentationSnapshot() < 0) throw new Error("Interface restart in progress");
  if (enabled === customNativePresentationEnabled()) return true;
  flushSync(() => setInterfaceApplying(true));
  try {
    const retirement = nativeWorkspaceRetirementBarrier();
    if (retirement && !await retirement) throw new Error("Previous interface is still active");
    const port = nativeDrawers();
    if (!port.applyInterfacePreference) throw new Error("Interface host unavailable");
    try {
      const receipt = await nativeDrawerAcknowledged(port.applyInterfacePreference({ documentId, enabled }));
      if (receipt.documentId !== documentId || receipt.enabled !== enabled) throw new Error("Interface receipt mismatch");
    } catch (error) {
      const state = await nativeDrawerAcknowledged(port.getCapabilities());
      if (state.interfaceDocumentId !== documentId || state.interfaceEnabled !== enabled) throw error;
    }
    acknowledgeNativeInterface(documentId, enabled);
    return true;
  } finally {
    setInterfaceApplying(false);
  }
}
