import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mocks, resetCommerceAccountFixture } from "./scope-commerce-mocks.fixture";
import { useNativePayments } from "@/components/profile/use-native-payments";

beforeEach(resetCommerceAccountFixture);
afterEach(cleanup);

function expectNoInformationAccessRequests() {
  for (const request of [mocks.account, mocks.readiness, mocks.sandboxVerified, mocks.activity, mocks.onboarding, mocks.checkout]) {
    expect(request).not.toHaveBeenCalled();
  }
}

describe("native payout composition", () => {
  it("keeps the original money and activity sections without loading information access", async () => {
    const { result } = renderHook(() => useNativePayments(true, true, "payments-owner"));
    await act(async () => {});
    expect(result.current.pages).toEqual([{ id: "payouts", title: "Payouts", sections: [
      { id: "payout-your-money", title: "Your money", rows: [] },
      { id: "payout-activity", title: "Activity", rows: [] },
    ] }]);
    expect(result.current.nested).toBe(false);
    expect(result.current.editor("payouts", () => {})).toBeNull();
    expectNoInformationAccessRequests();
    expect(mocks.answerGates).not.toHaveBeenCalled();
  });

  it("retains source-bound answer payout recovery without opening information access or starting onboarding", async () => {
    mocks.search = "commerceReturn=1&commerceAttemptId=opaque_attempt_12345&commerceSource=answers&commerceAction=onboarding_refresh";
    mocks.answerGates.mockResolvedValue({ payouts: true });
    mocks.answerAccount.mockResolvedValue({ stripeMode: "test", account: { ready: true, canManageBank: true } });
    const { result } = renderHook(() => useNativePayments(true, true, "payments-owner"));
    await waitFor(() => expect(mocks.answerAccount).toHaveBeenCalledWith("owner-token"));
    expect(result.current.pages[0]?.sections.map(section => section.title)).toEqual(["Answer payout setup", "Your money", "Activity"]);
    expect(result.current.pages[0]?.sections[0]?.rows.some(row => row.label === "Manage answer payouts")).toBe(true);
    expect(mocks.answerOnboarding).not.toHaveBeenCalled();
    expectNoInformationAccessRequests();
  });
});
