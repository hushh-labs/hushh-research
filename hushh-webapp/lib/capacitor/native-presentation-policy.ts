/** Renderer selection precedes capability discovery and the first visible frame.
 * The native bottom navigation shares this admission and otherwise stays React.
 * Custom controls are an explicit experimental opt-in on supported wrappers.
 * Old Debug launch flags cannot select or qualify a renderer.
 * The host snapshots the experimental device preference before WebView creation;
 * settings writes apply on the next process launch, never in this document.
 */
export function customNativePresentationEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const bootstrap = (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: {
    contractVersion: number; enabled: boolean; coherentShell?: boolean;
  } }).__HUSHH_NATIVE_DRAWER_BOOTSTRAP__;
  return bootstrap?.contractVersion === 1 && bootstrap.enabled === true && bootstrap.coherentShell === true;
}

/** Available independently of admission, so the React interface can opt in. */
export function nativeInterfacePreferenceAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const bootstrap = (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: {
    contractVersion: number; nativeInterfacePreference?: boolean;
  } }).__HUSHH_NATIVE_DRAWER_BOOTSTRAP__;
  return bootstrap?.contractVersion === 1 && bootstrap.nativeInterfacePreference === true;
}

/** Bootstrap capability for the private, immediate-choice family. This is not
 * a second preference switch and never qualifies rich/controlled popups. */
export function nativeOwnedChoicesEnabled(): boolean {
  if (!customNativePresentationEnabled()) return false;
  return (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: { ownedChoices?: boolean } })
    .__HUSHH_NATIVE_DRAWER_BOOTSTRAP__?.ownedChoices === true;
}
