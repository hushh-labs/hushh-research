/** Renderer selection precedes capability discovery and the first visible frame.
 * The standard native bottom navigation is independently owned and unchanged.
 * Custom controls remain React until a complete overlapping native family has
 * physical transition evidence. Old Debug launch flags cannot qualify a family.
 * No route, DOM inspection, preference or bridge receipt changes this policy.
 */
export function customNativePresentationEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const bootstrap = (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: {
    contractVersion: number; enabled: boolean; coherentShell?: boolean;
  } }).__HUSHH_NATIVE_DRAWER_BOOTSTRAP__;
  return bootstrap?.contractVersion === 1 && bootstrap.enabled === true && bootstrap.coherentShell === true;
}
