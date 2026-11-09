import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderPhoneVerificationFlow, reachCodeStep } from "@/__tests__/fixtures/phone-verification-flow";
import { ApiError } from "@/lib/services/api-client";

vi.mock("next/navigation", () => ({ usePathname: () => "/register-phone" }));

describe("occupied phone verification", () => {
  it.each(["PHONE_TEST_NUMBER_IN_USE", "PHONE_ALREADY_VERIFIED"])("does not request another SMS or delete the existing account: %s", async code => {
    const start = vi.fn().mockRejectedValue(new ApiError("Occupied", 409, { detail: { code } }));
    const transfer = vi.fn(); const remove = vi.fn();
    // No retained SMS proof exists for a start-step refusal, so in-place deletion stays closed.
    const flow = renderPhoneVerificationFlow({ startVerification: start, confirmTransfer: transfer, prepareLinkedDeletion: remove, confirmLinkedDeletion: vi.fn() });
    const input = screen.getByRole("textbox", { name: "Phone number" });
    fireEvent.change(input, { target: { value: "6505550101" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: "Delete my previous account" });
    expect(screen.queryByRole("button", { name: "Send a real SMS code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete my previous account" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use a different number" }));
    await screen.findByRole("textbox", { name: "Phone number" });
    expect(start).toHaveBeenCalledOnce(); expect(transfer).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(flow.confirmVerification).not.toHaveBeenCalled(); expect(flow.onCompleted).not.toHaveBeenCalled();
  });
  it("returns an unsent review to the choices and cancels its prepared operation", async () => {
    const prepare = vi.fn().mockResolvedValue({ operation_id: "prepared-op", state: "prepared", expires_at: "2099-01-01T00:00:00Z", transport: "sms", phone_hint: "••01" });
    const cancel = vi.fn().mockResolvedValue({ operation_id: "prepared-op", state: "cancelled" });
    const remove = vi.fn();
    const flow = renderPhoneVerificationFlow({
      confirmVerification: vi.fn().mockRejectedValue(new ApiError("Occupied", 409, { detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } })),
      prepareLinkedDeletion: prepare, confirmLinkedDeletion: remove, cancelLinkedDeletion: cancel, deletePreviousAccount: vi.fn(),
    });
    const input = await reachCodeStep(flow.startVerification);
    fireEvent.change(input, { target: { value: "123456" } }); fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    await screen.findByRole("button", { name: "Delete that account" });
    // Nothing was sent, so Cancel returns to the choices and cancels the prepared operation.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Delete my previous account" });
    await waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith("prepared-op"));
    expect(remove).not.toHaveBeenCalled(); expect(flow.onCompleted).not.toHaveBeenCalled();
  });
  it("confirms once, holds Back in flight, then after an unconfirmed answer leaves for number entry without re-offering the proof", async () => {
    const prepare = vi.fn().mockResolvedValue({ operation_id: "prepared-op", state: "prepared", expires_at: "2099-01-01T00:00:00Z", transport: "sms", phone_hint: "••01" });
    const cancel = vi.fn().mockResolvedValue({ operation_id: "prepared-op", state: "cancelled" });
    let finish!: (error: unknown) => void;
    const remove = vi.fn().mockReturnValue(new Promise((_, reject) => { finish = reject; }));
    const handoff = vi.fn();
    const back: { current: (() => boolean) | null } = { current: null };
    const flow = renderPhoneVerificationFlow({
      confirmVerification: vi.fn().mockRejectedValue(new ApiError("Occupied", 409, { detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } })),
      prepareLinkedDeletion: prepare, confirmLinkedDeletion: remove, cancelLinkedDeletion: cancel, deletePreviousAccount: handoff,
      onBackStepChange: handler => { back.current = handler; },
    });
    const input = await reachCodeStep(flow.startVerification);
    fireEvent.change(input, { target: { value: "123456" } }); fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    const submit = await screen.findByRole("button", { name: "Delete that account" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(submit); fireEvent.click(submit);
    // The route's Back is consumed, not followed, while the confirmation is in flight.
    expect(back.current?.()).toBe(true);
    expect(screen.getByRole("button", { name: "Requesting deletion…" })).toBeDisabled();
    expect(remove).toHaveBeenCalledExactlyOnceWith({ operationId: "prepared-op", phoneNumber: "+16505550101", testCode: undefined, recheck: false });
    finish(new ApiError("Unconfirmed", 409, { code: "PHONE_LINKED_DELETION_SUPPORT_REQUIRED" }));
    const check = await screen.findByRole("button", { name: "Check again" });
    // A sent confirmation cannot be cancelled or sent again; Check again only reads it back.
    expect(check).toHaveAttribute("data-voice-control-id", "phone-flow-delete-check");
    expect(screen.queryByRole("button", { name: "Delete that account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(check);
    await waitFor(() => expect(remove).toHaveBeenLastCalledWith({ operationId: "prepared-op", phoneNumber: "+16505550101", testCode: undefined, recheck: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Verify this number again" })).toBeEnabled();
    act(() => { expect(back.current?.()).toBe(true); });
    await screen.findByRole("textbox", { name: "Phone number" });
    expect(screen.queryByRole("button", { name: "Delete my previous account" })).toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce(); expect(handoff).not.toHaveBeenCalled(); expect(flow.onCompleted).not.toHaveBeenCalled();
    expect(flow.startVerification).toHaveBeenCalledOnce();
  });
  it("keeps the sign-in handoff for a phone sign-in that is itself an account", async () => {
    // The server only lets that account's owner delete it, so in-place review would always fail.
    const prepare = vi.fn(); const remove = vi.fn(); const handoff = vi.fn().mockResolvedValue(undefined);
    const flow = renderPhoneVerificationFlow({
      confirmVerification: vi.fn().mockRejectedValue(new ApiError("Occupied", 409, { detail: { code: "PHONE_SESSION_ACCOUNT_CONFLICT" } })),
      prepareLinkedDeletion: prepare, confirmLinkedDeletion: remove, deletePreviousAccount: handoff,
    });
    const input = await reachCodeStep(flow.startVerification);
    fireEvent.change(input, { target: { value: "123456" } }); fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    await waitFor(() => expect(handoff).toHaveBeenCalledExactlyOnceWith("+16505550101"));
    expect(prepare).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it("after a requested deletion, Back leads to number entry instead of the spent choices", async () => {
    const prepare = vi.fn().mockResolvedValue({ operation_id: "prepared-op", state: "prepared", expires_at: "2099-01-01T00:00:00Z", transport: "sms", phone_hint: "••01" });
    const remove = vi.fn().mockRejectedValue(new ApiError("Deletion requested.", 409, { code: "PHONE_LINKED_CLAIM_REQUIRED" }));
    const back: { current: (() => boolean) | null } = { current: null };
    const flow = renderPhoneVerificationFlow({
      confirmVerification: vi.fn().mockRejectedValue(new ApiError("Occupied", 409, { detail: { code: "PHONE_ALREADY_VERIFIED" } })),
      prepareLinkedDeletion: prepare, confirmLinkedDeletion: remove, cancelLinkedDeletion: vi.fn().mockResolvedValue({}),
      deletePreviousAccount: vi.fn(), onBackStepChange: handler => { back.current = handler; },
    });
    const input = await reachCodeStep(flow.startVerification);
    fireEvent.change(input, { target: { value: "123456" } }); fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(screen.getByRole("button", { name: "Delete that account" }));
    // Requested is not erased: no completion, and the spent proof offers no second deletion.
    await screen.findByRole("heading", { name: "Deletion requested" });
    expect(screen.getByRole("button", { name: "Verify this number again" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(flow.onCompleted).not.toHaveBeenCalled();
    act(() => { expect(back.current?.()).toBe(true); });
    await screen.findByRole("textbox", { name: "Phone number" });
    expect(screen.queryByRole("button", { name: "Delete my previous account" })).toBeNull();
    expect(remove).toHaveBeenCalledOnce(); expect(flow.startVerification).toHaveBeenCalledOnce();
  });
  it("keeps the previous-account sign-in only as the fallback when in-place deletion is unavailable", async () => {
    const prepare = vi.fn().mockRejectedValue(new ApiError("Unavailable", 503, { detail: { code: "PHONE_LINKED_DELETION_UNAVAILABLE" } }));
    const remove = vi.fn(); const handoff = vi.fn().mockResolvedValue(undefined);
    const flow = renderPhoneVerificationFlow({
      confirmVerification: vi.fn().mockRejectedValue(new ApiError("Occupied", 409, { detail: { code: "PHONE_ALREADY_VERIFIED" } })),
      prepareLinkedDeletion: prepare, confirmLinkedDeletion: remove, deletePreviousAccount: handoff,
    });
    const input = await reachCodeStep(flow.startVerification);
    fireEvent.change(input, { target: { value: "123456" } }); fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    await waitFor(() => expect(handoff).toHaveBeenCalledExactlyOnceWith("+16505550101"));
    expect(prepare).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
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
