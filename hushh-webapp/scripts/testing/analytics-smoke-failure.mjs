/** A tagged candidate can briefly reject static assets while Cloud Run scales it. */
export function isCandidateStaticAsset5xx({
  candidateOrigin,
  responseUrl,
  status,
}) {
  if (!Number.isInteger(status) || status < 500 || status > 599) return false;
  try {
    const candidate = new URL(candidateOrigin);
    const response = new URL(responseUrl);
    return (
      response.origin === candidate.origin &&
      response.pathname.startsWith("/_next/static/")
    );
  } catch {
    return false;
  }
}

/** Retry only before analytics has initialized, and only after candidate 5xx. */
export function isCandidateAssetUnavailable({
  phase,
  reason,
  failedAssetStatuses,
  observedEventNames,
  observedMeasurementIds,
  observedGaCollectEvents,
}) {
  return (
    phase === "measurement_id" &&
    /^page\.waitForFunction: Timeout \d+ms exceeded\./.test(reason) &&
    failedAssetStatuses.some(
      (status) => Number.isInteger(status) && status >= 500 && status <= 599,
    ) &&
    observedEventNames.length === 0 &&
    observedMeasurementIds.length === 0 &&
    observedGaCollectEvents.length === 0
  );
}

export async function getSafeJourneyState(page, expectedUserId) {
  return page.evaluate((expectedUserId) => {
    const bridge = window.__HUSHH_NATIVE_TEST__;
    const bootstrapStates = ["authenticated", "vault_unlocked", "auth_error", "uid_mismatch", "vault_error"];
    const path = window.location.pathname;
    const tab = new URLSearchParams(window.location.search).get("tab");
    const text = document.body?.textContent || "";
    const readinessMessages = ["Checking session", "Checking secure session", "Checking your setup", "Checking phone requirement", "Reconnecting securely"];
    const placement = document.querySelector("[data-kai-placement]")?.getAttribute("data-kai-placement");
    return {
      route: ["/login", "/kai", "/one/kai"].includes(path) ? path : "other",
      tab: ["market", "portfolio", "profile"].includes(tab) ? tab : "other",
      bootstrapState: bootstrapStates.includes(bridge?.bootstrapState) ? bridge.bootstrapState : "other",
      bootstrapOwnerMatches: Boolean(bridge?.bootstrapUserId && bridge.bootstrapUserId === expectedUserId),
      readOnly: bridge?.reviewerMutationPolicy === "read_only",
      financeWorkspacePresent: Boolean(document.querySelector("[data-finance-workspace]")),
      portfolioPanelActive: Boolean(document.querySelector('#top-shell-finance-panel-portfolio[aria-hidden="false"]')),
      portfolioOverviewPresent: Boolean(document.querySelector('[data-testid="portfolio-overview"]')),
      portfolioImportPresent: Boolean(document.querySelector('[data-testid="portfolio-import-upload-statement"]')),
      accountLoadingPresent: text.includes("Loading your account..."),
      sessionVerificationPresent: Boolean(document.querySelector("#session-verification-title")),
      registrationRecoveryPresent: Boolean(document.querySelector("#registration-recovery-title")),
      vaultUnlockPresent: Boolean(document.querySelector("#unlock-passphrase")),
      readinessMessage: readinessMessages.find(message => text.includes(message)) || "none",
      kaiPlacement: ["private", "unverified"].includes(placement) ? placement : "none",
    };
  }, expectedUserId);
}

/** Bounded, metadata-only evidence; raw URLs and error messages never leave handlers. */
export function createSafeJourneyDiagnostics(page, { appOrigin, expectedUserId }) {
  const journeyCheckpoints = [];
  const apiResponseCounts = new Map();
  const jsErrorClasses = new Set();
  page.on("pageerror", (error) => {
    jsErrorClasses.add(["TypeError", "ReferenceError", "SyntaxError", "RangeError", "Error"].includes(error.name) ? error.name : "OtherError");
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== appOrigin || !url.pathname.startsWith("/api/")) return;
    const family = ["pkm", "vault", "consent", "one", "auth", "account"].find(
      (value) => url.pathname === `/api/${value}` || url.pathname.startsWith(`/api/${value}/`),
    ) || "other";
    const key = `${family}:${response.status()}`;
    apiResponseCounts.set(key, (apiResponseCounts.get(key) || 0) + 1);
  });
  return {
    async capture(stage) {
      const state = await getSafeJourneyState(page, expectedUserId).catch(() => ({ unavailable: true }));
      journeyCheckpoints.push({ stage, ...state });
    },
    summary() {
      return { journeyCheckpoints, apiResponseCounts: Object.fromEntries(apiResponseCounts),
        jsErrorClasses: [...jsErrorClasses].sort() };
    },
  };
}

export function classifySmokeFailure(message) {
  if (/missing canonical reviewer test identity/i.test(message)) {
    return "missing_fixture_credentials";
  }
  if (
    /portfolio_viewed|recommendation_viewed|investor_activation_completed/i.test(
      message,
    )
  ) {
    return "portfolio_analysis_or_activation_instrumentation";
  }
  if (/measurement ID|forbidden production measurement/i.test(message)) {
    return "measurement_id_or_sink_mismatch";
  }
  return "runtime_or_instrumentation_failure";
}
