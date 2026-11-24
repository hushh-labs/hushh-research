/** The iOS path monitor can observe a usable route while WKWebView reports offline. */
export function isNetworkOnline(): boolean {
  const native = typeof window === "undefined" ? undefined :
    (window as Window & { __HUSHH_NETWORK_ONLINE__?: boolean }).__HUSHH_NETWORK_ONLINE__;
  return native ?? (typeof navigator === "undefined" || navigator.onLine !== false);
}
