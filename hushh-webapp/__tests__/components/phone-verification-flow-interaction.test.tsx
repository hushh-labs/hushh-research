import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";

function renderPhoneVerificationFlow(options?: { startRejects?: boolean }) {
  const startVerification = options?.startRejects
    ? vi.fn().mockRejectedValue(new Error("provider unavailable"))
    : vi.fn().mockResolvedValue({ autoVerified: false });
  const confirmVerification = vi.fn().mockResolvedValue({ uid: "user_1" });
  const onCompleted = vi.fn();

  render(
    <PhoneVerificationFlow
      mode="link"
      startVerification={startVerification}
      confirmVerification={confirmVerification}
      onCompleted={onCompleted}
    />
  );

  return {
    startVerification,
    confirmVerification,
    onCompleted,
  };
}

async function selectIndiaOnce() {
  const countryInput = screen.getByRole("combobox", {
    name: "Country code",
  }) as HTMLInputElement;

  fireEvent.focus(countryInput);

  const indiaOption = await screen.findByText("India");
  const indiaItem = (indiaOption.closest("[data-slot='combobox-item']") ??
    indiaOption) as Element;

  fireEvent.pointerDown(indiaItem);
  fireEvent.click(indiaItem);

  await waitFor(() => {
    expect(countryInput.value).toBe("India (+91)");
  });

  return countryInput;
}

describe("PhoneVerificationFlow country selector", () => {
  it("shows India immediately after the first country selection", async () => {
    renderPhoneVerificationFlow();

    await selectIndiaOnce();
  });

  it("uses the first selected country when sending the verification phone number", async () => {
    const { startVerification } = renderPhoneVerificationFlow();

    await selectIndiaOnce();

    fireEvent.change(screen.getByRole("textbox", { name: "Phone number" }), {
      target: { value: "8004482372" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));

    await waitFor(() => {
      expect(startVerification).toHaveBeenCalledWith("+918004482372", {
        resendCode: false,
      });
    });
  });

  it("reports a failed voice settlement when the SMS provider rejects", async () => {
    renderPhoneVerificationFlow({ startRejects: true });
    await waitFor(() => {
      expect(resolveLocalOnboardingHandler("phone_mandate.submit_number")).not.toBeNull();
    });

    const result = await resolveLocalOnboardingHandler("phone_mandate.submit_number")?.({
      phoneNumber: "+16505550101",
    });

    expect(result).toMatchObject({ status: "failed" });
  });

  it("keeps the spoken code transient and settles only after confirmation succeeds", async () => {
    const { confirmVerification, onCompleted } = renderPhoneVerificationFlow();
    await waitFor(() => {
      expect(resolveLocalOnboardingHandler("phone_mandate.submit_number")).not.toBeNull();
    });
    await resolveLocalOnboardingHandler("phone_mandate.submit_number")?.({
      phoneNumber: "+16505550101",
    });
    await waitFor(() => {
      expect(resolveLocalOnboardingHandler("phone_mandate.submit_code")).not.toBeNull();
    });

    const result = await resolveLocalOnboardingHandler("phone_mandate.submit_code")?.({
      code: "123456",
    });

    expect(confirmVerification).toHaveBeenCalledWith("123456");
    expect(onCompleted).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result?.summary).not.toContain("123456");
  });
});
