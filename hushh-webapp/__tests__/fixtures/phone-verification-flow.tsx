import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";

export function renderPhoneVerificationFlow(options?: {
  startRejects?: boolean;
  confirmTransfer?: ReturnType<typeof vi.fn>;
  recoverPreviousAccount?: ReturnType<typeof vi.fn>;
  deletePreviousAccount?: ReturnType<typeof vi.fn>;
  prepareLinkedDeletion?: ReturnType<typeof vi.fn>;
  confirmLinkedDeletion?: ReturnType<typeof vi.fn>;
  cancelLinkedDeletion?: ReturnType<typeof vi.fn>;
  codePresentation?: "onboarding";
  phonePresentation?: "compact";
  confirmVerification?: ReturnType<typeof vi.fn>;
  currentPhoneNumber?: string | null;
  mode?: "link" | "replace";
  startVerification?: ReturnType<typeof vi.fn>;
  onContinueExisting?: ReturnType<typeof vi.fn>;
  onBackStepChange?: (handler: (() => boolean) | null) => void;
  isCurrent?: () => boolean;
}) {
  const startVerification = options?.startVerification ?? (options?.startRejects
    ? vi.fn().mockRejectedValue(new Error("provider unavailable"))
    : vi.fn().mockResolvedValue({ autoVerified: false }));
  const confirmVerification =
    options?.confirmVerification ??
    vi.fn().mockResolvedValue({ uid: "user_1" });
  const onCompleted = vi.fn();

  const flow = (currentPhoneNumber?: string | null) => (
    <PhoneVerificationFlow
      mode={options?.mode ?? "link"}
      codePresentation={options?.codePresentation}
      phonePresentation={options?.phonePresentation}
      currentPhoneNumber={currentPhoneNumber}
      startVerification={startVerification}
      confirmVerification={confirmVerification}
      confirmTransfer={options?.confirmTransfer}
      recoverPreviousAccount={options?.recoverPreviousAccount}
      deletePreviousAccount={options?.deletePreviousAccount}
      prepareLinkedDeletion={options?.prepareLinkedDeletion}
      confirmLinkedDeletion={options?.confirmLinkedDeletion}
      cancelLinkedDeletion={options?.cancelLinkedDeletion}
      onCompleted={onCompleted}
      onContinueExisting={options?.onContinueExisting}
      onBackStepChange={options?.onBackStepChange}
      isCurrent={options?.isCurrent}
    />
  );

  const view = render(flow(options?.currentPhoneNumber));

  return {
    startVerification,
    confirmVerification,
    onCompleted,
    unmount: view.unmount,
    // Republishes the flow with a new auth-context phone value, the way
    // register-phone/page.tsx does when useAuth().phoneNumber settles.
    rerenderWithPhone: (next?: string | null) => view.rerender(flow(next)),
  };
}

export async function reachCodeStep(startVerification: ReturnType<typeof vi.fn>) {
  const phoneInput = screen.getByRole("textbox", { name: "Phone number" });
  fireEvent.change(phoneInput, { target: { value: "6505550101" } });
  fireEvent.submit(phoneInput.closest("form")!);
  await waitFor(() => expect(startVerification).toHaveBeenCalledTimes(1));
  return screen.findByRole("textbox", { name: "One-time code" });
}

export async function selectCountryOnce(countryName: string, countryLabel: string) {
  const countryInput = screen.getByRole("combobox", {
    name: "Country code",
  }) as HTMLInputElement;

  fireEvent.focus(countryInput);

  const countryOption = await screen.findByText(countryName);
  const countryItem = (countryOption.closest("[data-slot='combobox-item']") ??
    countryOption) as Element;

  fireEvent.pointerDown(countryItem);
  fireEvent.click(countryItem);

  await waitFor(() => {
    expect(countryInput.value).toBe(countryLabel);
  });

  return countryInput;
}

export async function selectIndiaOnce() {
  return selectCountryOnce("India", "India (+91)");
}

