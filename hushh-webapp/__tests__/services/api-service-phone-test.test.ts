import { capacitorMocks } from "../fixtures/api-service-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "@/lib/services/api-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { jsonResponse } from "../fixtures/api-service-responses";
const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
describe("fixed phone test API transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    capacitorMocks.isNativePlatform.mockReturnValue(false);
    capacitorMocks.getPlatform.mockReturnValue("web");
    publishValidatedAuthSessionOwner(null);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it("@feature_auth_reliability preserves a null confirmation error body as ApiError", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null, 409));
    const error = await ApiService.confirmUatPhoneTestVerification(
      "+16505550101", "123456", "uat-test-phone:fixture", "firebase-id-token",
    ).catch(failure => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.payload).toBeNull();
    expect(error.message).toBe("UAT phone test verification failed with HTTP 409");
  });
  it.each([
    { success: true, reason: "uat_phone_test_not_configured_or_not_allowlisted" },
    { success: true, eligible: "false", reason: "uat_phone_test_not_configured_or_not_allowlisted" },
    { success: true, eligible: true, verification_id: " " },
    { success: true, eligible: true, verification_id: "firebase-session" },
    { success: false, eligible: true, verification_id: "uat-test-phone:abc123" },
  ])("rejects malformed phone-test eligibility instead of authorizing fallback: %j", async (body) => {
    mockFetch.mockResolvedValueOnce(jsonResponse(body));
    await expect(ApiService.startUatPhoneTestVerification("+16505550101", "firebase-id-token"))
      .rejects.toMatchObject({ status: 502, payload: { code: "PHONE_TEST_START_INVALID_RESPONSE" } });
  });

  it("retains an explicit successful nonallowlisted phone-test fallback", async () => {
    const body = { success: true, eligible: false, reason: "uat_phone_test_not_configured_or_not_allowlisted" };
    mockFetch.mockResolvedValueOnce(jsonResponse(body));
    expect(await ApiService.startUatPhoneTestVerification("+16505550101", "firebase-id-token")).toMatchObject(body);
  });

  it.each(["start", "confirm"] as const)("@feature_auth_reliability preserves fixed-code %s errors as typed responses", async (phase) => {
    const payload = { detail: { code: "PHONE_TEST_NUMBER_IN_USE", message: "Use a different number." } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload, 409));
    const pending = phase === "start"
      ? ApiService.startUatPhoneTestVerification("+16505550101", "firebase-id-token")
      : ApiService.confirmUatPhoneTestVerification("+16505550101", "123456", "uat-test-phone:fixture", "firebase-id-token");
    const error = await pending.catch(failure => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.payload).toEqual(payload);
    expect(apiErrorCode(error)).toBe("PHONE_TEST_NUMBER_IN_USE");
  });

});
