import { expect, it } from "vitest";
import { ApiError } from "@/lib/services/api-client";
import { accountCleanupProvider } from "@/lib/services/account-cloud-cleanup";

it.each(["gcp", "azure"] as const) ("@feature_account_deletion @trace_loop surfaces the reviewed %s removal handoff for the exact deletion blocker", provider => {
  const detail = { code: "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING", cleanupProvider: provider };
  expect(accountCleanupProvider(new ApiError("Cleanup needed", 409, { detail }))).toBe(provider);
  expect(accountCleanupProvider(new ApiError("Other failure", 409, { detail: { ...detail, code: "OTHER" } }))).toBeNull();
  expect(accountCleanupProvider({ payload: { detail } })).toBeNull();
  expect(accountCleanupProvider(new ApiError("Unknown cloud", 409, { detail: { ...detail, cleanupProvider: "managed" } }))).toBeNull();
});
