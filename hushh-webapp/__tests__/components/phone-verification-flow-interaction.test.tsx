import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";

function renderPhoneVerificationFlow() {
  const startVerification = vi.fn().mockResolvedValue({ autoVerified: false });
  const confirmVerification = vi.fn();
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
});
