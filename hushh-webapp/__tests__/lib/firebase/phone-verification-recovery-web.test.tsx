// Register the shared provider mocks before importing the provider itself.
import { mocks, deferred, makeUser, SessionProbe, VerifiedPhoneProbe, resetWebAuthMocks, cleanupWebAuthMocks } from "./fixtures/auth-context-web-harness";
import { AuthProvider } from "@/lib/firebase/auth-context";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/services/api-client";

describe("@feature_auth_reliability @trace_loop web phone verification recovery", () => {
  beforeEach(resetWebAuthMocks);
  afterEach(cleanupWebAuthMocks);

  it("@feature_auth_reliability @trace_loop retains the actionable ownership conflict when fresh-proof recovery is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_PHONE_RECOVERY_ENABLED", "false");
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    mocks.phoneFinalize.mockRejectedValue(new ApiError(
      "This phone number is already verified for another account. Sign in to that account or use a different phone number.",
      409, { detail: { code: "PHONE_ALREADY_VERIFIED" } },
    ));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Sign in to that account or use a different phone number");
    expect(mocks.phoneLinkStart).not.toHaveBeenCalled();
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it.each(["PHONE_ALREADY_VERIFIED", "PHONE_VERIFICATION_CHANGED"])("collects fresh web possession proof after %s when recovery is enabled", async code => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_PHONE_RECOVERY_ENABLED", "true");
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    mocks.phoneFinalize.mockRejectedValue(new ApiError("Existing provider phone needs fresh proof", 409, { detail: { code } }));
    mocks.identityClaim.mockResolvedValue({ user_id: "account-owner", phone_number: "+12025550101", phone_verified: true });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    expect(mocks.phoneLinkStart).toHaveBeenCalledWith("+12025550101", expect.objectContaining({ allowLinkedPhoneProof: true }));
    expect(mocks.identityClaim).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneClaimToken).toHaveBeenCalledWith({ verificationCode: "123456", verificationId: "web-otp-verification" });
    expect(mocks.identityClaim).toHaveBeenCalledWith(mocks.firebaseUser, "phone-id-token");
  });

  it.each([
    { status: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE" },
    { status: 409, code: "OTHER_CONFLICT" },
  ])("does not turn a persistence failure into fresh proof: $status $code", async ({ status, code }) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_PHONE_RECOVERY_ENABLED", "true");
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    mocks.phoneFinalize.mockRejectedValue(new ApiError("Persistence rejected", status, { detail: { code } }));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Persistence rejected");
    expect(mocks.phoneLinkStart).not.toHaveBeenCalled();
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it("@feature_auth_reliability @trace_loop does not replay an expired phone credential and accepts a fresh explicit send", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    mocks.phoneClaimToken.mockRejectedValueOnce(Object.assign(new Error("Expired provider code"), { code: "auth/code-expired" }));
    mocks.identityClaim.mockResolvedValue({ user_id: "account-owner", phone_number: "+12025550101", phone_verified: true });
    mocks.phoneLinkStart
      .mockResolvedValueOnce({ autoVerified: false, verificationId: "expired-verification" })
      .mockResolvedValueOnce({ autoVerified: false, verificationId: "fresh-verification" });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneClaimToken).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Request a new verification code");
    expect(mocks.phoneClaimToken).toHaveBeenCalledTimes(1);
    expect(mocks.identityClaim).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneClaimToken).toHaveBeenLastCalledWith({ verificationCode: "123456", verificationId: "fresh-verification" });
    expect(mocks.identityClaim).toHaveBeenCalledWith(mocks.firebaseUser, "phone-id-token");
    expect(mocks.phoneLinkStart).toHaveBeenCalledTimes(2);
  });

  it("@feature_auth_reliability @trace_loop keeps a newer resend usable when an older provider check later reports expiry", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const oldProof = deferred<string>();
    mocks.phoneClaimToken.mockReturnValueOnce(oldProof.promise);
    mocks.identityClaim.mockResolvedValue({ user_id: "account-owner", phone_number: "+12025550101", phone_verified: true });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" }));
    await waitFor(() => expect(mocks.phoneClaimToken).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { oldProof.reject(Object.assign(new Error("Expired old code"), { code: "code-expired" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneClaimToken).toHaveBeenCalledTimes(2);
    expect(mocks.identityClaim).toHaveBeenCalledTimes(1);
  });

});
