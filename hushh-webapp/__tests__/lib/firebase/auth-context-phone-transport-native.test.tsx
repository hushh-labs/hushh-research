import { mocks, makeUser, activeSessionResponse, NativePhoneProbe, SessionProbe, resetNativeAuthMocks, cleanupNativeAuthMocks } from "./fixtures/auth-context-native-harness";
import { AuthProvider } from "@/lib/firebase/auth-context";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
describe("explicit native phone proof selection", () => {
  beforeEach(resetNativeAuthMocks);
  afterEach(cleanupNativeAuthMocks);
  it("@feature_auth_reliability explicitly starts native SMS without reusing a fixed test challenge", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneTestStart.mockResolvedValue({ success: true, eligible: false, reason: "phone_test_number_in_use" });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe transport="sms" /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    fireEvent.click(screen.getByRole("button", { name: "Start native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("code ready"));
    expect(mocks.phoneTestStart).not.toHaveBeenCalled();
    expect(mocks.phoneStart).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      allowLinkedPhoneProof: true, signal: expect.any(AbortSignal),
    }));
    expect(mocks.phoneTestConfirm).not.toHaveBeenCalled();
  });

});
