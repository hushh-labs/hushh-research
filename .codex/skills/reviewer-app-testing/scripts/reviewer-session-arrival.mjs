// Observe ordinary routing after owner admission; never navigate or change setup.
export function createReviewerArrival({
  redirectUrl, requireVaultUnlocked, allowQueryMutation,
  allowFirstRunSetupRedirect, reviewerUid,
}) {
  const firstRunPaths = ["/one/setup", "/one/setup/connections"];
  if (allowFirstRunSetupRedirect &&
      (requireVaultUnlocked || !firstRunPaths.includes(redirectUrl.pathname))) {
    throw new Error("First-run arrival requires a setup entry without vault admission.");
  }
  const admission = {
    targetPath: redirectUrl.pathname,
    targetHref: `${redirectUrl.pathname}${redirectUrl.search}`,
    origin: redirectUrl.origin,
    queryMayChange: allowQueryMutation,
    firstRun: allowFirstRunSetupRedirect,
    firstRunPaths,
    reviewerUid,
  };
  return async (page, timeoutMs) => {
    await page.waitForFunction((expected) => {
      const path = window.location.pathname;
      if (!expected.firstRun) {
        return expected.queryMayChange ? path === expected.targetPath
          : `${path}${window.location.search}` === expected.targetHref;
      }
      const bridge = window.__HUSHH_NATIVE_TEST__;
      if (window.location.origin !== expected.origin ||
          !expected.firstRunPaths.includes(path) ||
          (!expected.queryMayChange && window.location.search !== "") ||
          bridge?.bootstrapUserId !== expected.reviewerUid ||
          !["authenticated", "vault_unlocked"].includes(bridge?.bootstrapState)) return false;
      const selector = path === "/one/setup"
        ? '[data-native-route-marker="true"][data-native-route-id="/one/setup"][data-native-auth-default="authenticated"][data-native-data-default="loaded"]'
        : '[data-native-test-beacon="true"][data-native-route-id="/one/setup/connections"][data-native-auth-state="authenticated"][data-native-data-state="loaded"]';
      return !!document.querySelector(selector);
    }, admission, { timeout: timeoutMs });
  };
}
