// Register the shared provider mocks before importing the provider itself.
import { mocks, deferred, makeUser, SessionProbe, VerifiedPhoneProbe, resetWebAuthMocks, cleanupWebAuthMocks } from "./fixtures/auth-context-web-harness";
import { AuthProvider } from "@/lib/firebase/auth-context";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/services/api-client";

describe("@feature_auth_reliability @trace_loop web phone verification recovery", () => {
  beforeEach(resetWebAuthMocks);
  afterEach(cleanupWebAuthMocks);

  it("@feature_auth_reliability @trace_loop retains the actionable ownership conflict without creating a separate Firebase session", async () => {
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

  it.each(["PHONE_ALREADY_VERIFIED", "PHONE_VERIFICATION_CHANGED"])("surfaces %s without collecting secondary proof", async code => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_PHONE_RECOVERY_ENABLED", "true");
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    mocks.phoneFinalize.mockRejectedValue(new ApiError("Existing provider phone could not be saved", 409, { detail: { code } }));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Existing provider phone could not be saved");
    expect(mocks.phoneLinkStart).not.toHaveBeenCalled();
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it("retries the same provider link's backend save without consuming another OTP", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    mocks.phoneFinalize.mockRejectedValueOnce(new Error("Temporary save outage"));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Temporary save outage");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledOnce();
    expect(mocks.phoneFinalize).toHaveBeenCalledTimes(2);
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(screen.getByText("Vault content for account-owner")).toBeInTheDocument();
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
    mocks.phoneLinkConfirm.mockRejectedValueOnce(Object.assign(new Error("Expired provider code"), { code: "auth/code-expired" }));
    mocks.phoneLinkStart
      .mockResolvedValueOnce({ autoVerified: false, verificationId: "expired-verification" })
      .mockResolvedValueOnce({ autoVerified: false, verificationId: "fresh-verification", expectedUserId: "account-owner" });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Request a new verification code");
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneLinkConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ verificationCode: "123456", verificationId: "fresh-verification", expectedUserId: "account-owner", phoneNumber: "+12025550101" }));
    expect(mocks.phoneFinalize).toHaveBeenCalledWith(mocks.firebaseUser, "+12025550101");
    expect(mocks.phoneLinkStart).toHaveBeenCalledTimes(2);
  });

  it("holds the account slot through confirmation and lets the user resend after it settles", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const oldProof = deferred<ReturnType<typeof makeUser>>();
    mocks.phoneLinkConfirm.mockReturnValueOnce(oldProof.promise);
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const send = screen.getByRole("button", { name: "Send phone OTP" });
    const confirm = screen.getByRole("button", { name: "Confirm phone OTP" });
    await act(async () => { fireEvent.click(send); });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.phoneLinkConfirm).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(send); fireEvent.click(confirm); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Phone verification is finishing");
    expect(mocks.phoneLinkStart).toHaveBeenCalledOnce();
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledOnce();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();

    await act(async () => { oldProof.reject(Object.assign(new Error("Expired old code"), { code: "code-expired" })); });
    await act(async () => { fireEvent.click(send); });
    await act(async () => { fireEvent.click(confirm); });
    expect(mocks.phoneLinkStart).toHaveBeenCalledTimes(2);
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledTimes(2);
    expect(mocks.phoneFinalize).toHaveBeenCalledOnce();
  });

  it("reads back a provider link after a lost response before resending the OTP credential", async () => {
    const user = makeUser("account-owner", "");
    mocks.firebaseUser = user;
    mocks.phoneLinkConfirm.mockImplementationOnce(async () => {
      Object.assign(user, { phoneNumber: "+12025550101" });
      throw new Error("Firebase response was lost");
    });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const confirm = screen.getByRole("button", { name: "Confirm phone OTP" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(confirm); });
    expect(screen.getByTestId("phone-error")).toHaveTextContent("Firebase response was lost");
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(confirm); });
    expect(mocks.phoneLinkConfirm).toHaveBeenCalledOnce();
    expect(mocks.phoneFinalize).toHaveBeenCalledExactlyOnceWith(user, "+12025550101");
  });
});
