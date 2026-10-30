import { mocks, VerifiedPhoneProbe, resetWebAuthMocks, cleanupWebAuthMocks } from "./fixtures/auth-context-web-harness";
import { AuthProvider } from "@/lib/firebase/auth-context";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
describe("phone test transport selection", () => {
  beforeEach(resetWebAuthMocks);
  afterEach(cleanupWebAuthMocks);
  it.each([
    { response: null, message: "temporarily unavailable" },
    { response: { success: false, eligible: false }, message: "temporarily unavailable" },
    { response: { success: true, eligible: true }, message: "temporarily unavailable" },
    { response: { success: true, eligible: false, reason: "unknown" }, message: "temporarily unavailable" },
    { response: { success: true, reason: "uat_phone_test_not_configured_or_not_allowlisted" }, message: "temporarily unavailable" },
    { response: { success: true, eligible: false, reason: "phone_test_number_in_use" }, message: "shared test code cannot transfer" },
  ])("@feature_auth_reliability stops web test transport refusal before Firebase: $message", async ({ response, message }) => {
    mocks.phoneTestStart.mockResolvedValue(response);
    render(<AuthProvider><VerifiedPhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("account-owner"));
    fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" }));
    await waitFor(() => expect(screen.getByTestId("phone-error")).toHaveTextContent(message));
    expect(mocks.phoneLinkStart).not.toHaveBeenCalled();
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
  });

  it("@feature_auth_reliability starts a separate SMS proof only after an explicit choice", async () => {
    mocks.phoneTestStart.mockResolvedValue({ success: true, eligible: false, reason: "phone_test_number_in_use" });
    const view = render(<AuthProvider><VerifiedPhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("account-owner"));
    fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" }));
    await waitFor(() => expect(screen.getByTestId("phone-error")).toHaveTextContent("shared test code cannot transfer"));
    view.rerender(<AuthProvider><VerifiedPhoneProbe transport="sms" /></AuthProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" }));
    await waitFor(() => expect(mocks.phoneLinkStart).toHaveBeenCalledOnce());
    expect(mocks.phoneTestStart).toHaveBeenCalledOnce();
    expect(mocks.phoneLinkStart).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ allowLinkedPhoneProof: true }));
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

});
