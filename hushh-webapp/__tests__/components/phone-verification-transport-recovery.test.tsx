import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderPhoneVerificationFlow, reachCodeStep } from "@/__tests__/fixtures/phone-verification-flow";
import { ApiError } from "@/lib/services/api-client";

vi.mock("next/navigation", () => ({ usePathname: () => "/register-phone" }));

describe("occupied phone verification", () => {
  it.each(["PHONE_TEST_NUMBER_IN_USE", "PHONE_ALREADY_VERIFIED"])("does not request another SMS or delete the existing account: %s", async code => {
    const start = vi.fn().mockRejectedValue(new ApiError("Occupied", 409, { detail: { code } }));
    const transfer = vi.fn(); const remove = vi.fn();
    const flow = renderPhoneVerificationFlow({ startVerification: start, confirmTransfer: transfer, prepareLinkedDeletion: remove });
    const input = screen.getByRole("textbox", { name: "Phone number" });
    fireEvent.change(input, { target: { value: "6505550101" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: "Account options" });
    expect(screen.queryByRole("button", { name: "Send a real SMS code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete my previous account" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use a different number" }));
    await screen.findByRole("textbox", { name: "Phone number" });
    expect(start).toHaveBeenCalledOnce(); expect(transfer).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(flow.confirmVerification).not.toHaveBeenCalled(); expect(flow.onCompleted).not.toHaveBeenCalled();
  });
  it("leaves an incorrect OTP editable without authorizing a phone takeover", async () => {
    const confirm = vi.fn().mockRejectedValue(new ApiError("Invalid", 401, { detail: { code: "UAT_PHONE_TEST_INVALID_CODE" } }));
    const flow = renderPhoneVerificationFlow({ confirmVerification: confirm, codePresentation: "onboarding" });
    const input = await reachCodeStep(flow.startVerification);
    fireEvent.change(input, { target: { value: "123456" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByText("That code isn't right. Check it and try again.");
    fireEvent.change(input, { target: { value: "123455" } });
    await waitFor(() => expect(screen.queryByText("That code isn't right. Check it and try again.")).toBeNull());
    expect(flow.onCompleted).not.toHaveBeenCalled();
  });
});
