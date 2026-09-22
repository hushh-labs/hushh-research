import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS,
  ACCOUNT_SESSION_VALIDATION_BUDGET_MS,
} from "@/lib/auth/account-session-policy";

describe("account session timeout policy", () => {
  it("keeps the orchestration deadline outside both possible backend probes", () => {
    expect(ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS).toBeGreaterThan(9_000);
    expect(ACCOUNT_SESSION_VALIDATION_BUDGET_MS).toBeGreaterThanOrEqual(
      ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS * 2 + 6_000,
    );
  });
});
