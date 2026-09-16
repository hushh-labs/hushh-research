import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

// The backend owns up to 9s in production and 20s locally for authoritative
// revocation/deletion verification. Preserve explicit network margin around it.
export const ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS =
  resolveSlowRequestTimeoutMs(12_000, {
    developmentFloorMs: 25_000,
    overrideEnvKey: "HUSHH_ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS",
  });

const configuredValidationBudgetMs = resolveSlowRequestTimeoutMs(30_000, {
  developmentFloorMs: 60_000,
  overrideEnvKey: "HUSHH_ACCOUNT_SESSION_VALIDATION_TIMEOUT_MS",
});

// A stale credential can require two backend probes with a forced Firebase
// refresh between them. Enforce the nesting even when runtime overrides are
// misconfigured so the outer privacy gate never expires before its children.
export const ACCOUNT_SESSION_VALIDATION_BUDGET_MS = Math.max(
  configuredValidationBudgetMs,
  ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS * 2 + 6_000,
);
