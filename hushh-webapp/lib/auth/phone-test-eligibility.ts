import { ApiError } from "@/lib/services/api-client";
import type { AccountPhoneTestStartResponse } from "@/lib/services/api-service";

/** A declined or unavailable test transport never implicitly authorizes SMS. */
export function requireUsablePhoneTestStart(result: AccountPhoneTestStartResponse | null): void {
  if (result?.success && result.reason === "phone_test_number_in_use") {
    throw new ApiError("A shared test code cannot transfer a number. Recover the previous account or use another number.",
      409, { code: "PHONE_TEST_NUMBER_IN_USE" });
  }
  if (!result?.success || typeof result.eligible !== "boolean" ||
      (result.eligible && !result.verification_id) ||
      (!result.eligible && result.reason !== "uat_phone_test_not_configured_or_not_allowlisted")) {
    throw new ApiError("Phone verification is temporarily unavailable. Please try again.",
      503, { code: "PHONE_TEST_START_UNAVAILABLE" });
  }
}
