import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS,
  ACCOUNT_SESSION_VALIDATION_BUDGET_MS,
} from "@/lib/auth/account-session-policy";
import { withinAccountSessionValidationBudget } from "@/lib/auth/account-session-status";

describe("account session timeout policy", () => {
  it("keeps the orchestration deadline outside both possible backend probes", () => {
    expect(ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS).toBeGreaterThan(9_000);
    expect(ACCOUNT_SESSION_VALIDATION_BUDGET_MS).toBeGreaterThanOrEqual(
      ACCOUNT_SESSION_STATUS_REQUEST_TIMEOUT_MS * 2 + 6_000,
    );
  });

  it("keeps an expired budget rejected while observing its started request", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    let rejectRequest!: (error: Error) => void;
    const request = new Promise<string>((_resolve, reject) => { rejectRequest = reject; });
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = withinAccountSessionValidationBudget(request, Date.now() - 1);
      await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      rejectRequest(new Error("Synthetic lifecycle transport rejected"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      await request.catch(() => undefined);
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves the actual request failure while time remains", async () => {
    const failure = new Error("Synthetic lifecycle request failed");
    await expect(withinAccountSessionValidationBudget(
      Promise.reject(failure), Date.now() + 1_000,
    )).rejects.toBe(failure);
  });
});
