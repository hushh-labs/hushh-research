import { expect, it } from "vitest";
import { ApiError } from "@/lib/services/api-client";
import { accountCleanupProvider, parseCloudCleanupView } from "@/lib/services/account-cloud-cleanup";

it("accepts only a dated UTC provider recheck hint without changing finalization or approval", () => {
  const view = { operationId: "retained-attempt", planDigest: "a".repeat(64), resources: [],
    removed: 10, total: 17, canFinalize: false, approvalRequired: true };
  expect(parseCloudCleanupView({ ...view, nextEligibleAt: "2099-11-13T07:03:50.404Z" }))
    .toMatchObject({ nextEligibleAt: "2099-11-13T07:03:50.404Z", canFinalize: false, approvalRequired: true });
  for (const nextEligibleAt of [null, "unknown", "2099-11-13T07:03:50", "2099-99-99T07:03:50Z"]) {
    expect(parseCloudCleanupView({ ...view, nextEligibleAt }).nextEligibleAt).toBeUndefined();
  }
});

it.each(["gcp", "azure"] as const) ("@feature_account_deletion @trace_loop surfaces the reviewed %s removal handoff for the exact deletion blocker", provider => {
  const detail = { code: "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING", cleanupProvider: provider };
  expect(accountCleanupProvider(new ApiError("Cleanup needed", 409, { detail }))).toBe(provider);
  expect(accountCleanupProvider(new ApiError("Other failure", 409, { detail: { ...detail, code: "OTHER" } }))).toBeNull();
  expect(accountCleanupProvider({ payload: { detail } })).toBeNull();
  expect(accountCleanupProvider(new ApiError("Unknown cloud", 409, { detail: { ...detail, cleanupProvider: "managed" } }))).toBeNull();
});
