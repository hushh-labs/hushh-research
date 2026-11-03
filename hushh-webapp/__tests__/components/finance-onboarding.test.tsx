import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinanceOnboardingComplete,
  FinanceOnboardingDemo,
  FinanceSourcePicker,
} from "@/components/kai/onboarding/finance-onboarding";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

vi.mock("next/navigation", () => ({ usePathname: () => "/one/setup/finance" }));
beforeEach(() =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  ),
);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Finance introduction", () => {
  it("only continues after the final deliberate step and supports authored Back", () => {
    const done = vi.fn();
    render(<FinanceOnboardingDemo onContinue={done} />);
    expect(
      screen.getByRole("heading", { name: "Follow the market." }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(done).not.toHaveBeenCalled();
    act(() => {
      expect(unwindBackLayer("/one/setup/finance")).toBe(true);
    });
    expect(
      screen.getByRole("heading", { name: "Follow the market." }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show Stocks introduction" }),
    );
    expect(done).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(done).toHaveBeenCalledOnce();
  });

  it("does not autoplay with reduced motion and Skip only opens source selection", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    render(<FinanceOnboardingDemo onContinue={done} />);
    act(() => vi.advanceTimersByTime(24000));
    expect(
      screen.getByRole("heading", { name: "Follow the market." }),
    ).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Skip", exact: true }));
    expect(done).toHaveBeenCalledOnce();
  });

  it("uses app Back for source selection and consumes Back while importing", () => {
    const back = vi.fn();
    const props = {
      onConnect: vi.fn(),
      onStatement: vi.fn(),
      onSample: vi.fn(),
      onSkip: vi.fn(),
      onBack: back,
      plaidAvailable: true,
      sampleAvailable: true,
    };
    const { rerender } = render(
      <FinanceSourcePicker {...props} busy={false} />,
    );
    expect(
      screen.queryByRole("button", { name: "Back to Finance introduction" }),
    ).toBeNull();
    act(() => {
      expect(unwindBackLayer("/one/setup/finance")).toBe(true);
    });
    expect(back).toHaveBeenCalledOnce();
    rerender(<FinanceSourcePicker {...props} busy />);
    act(() => {
      expect(unwindBackLayer("/one/setup/finance")).toBe(true);
    });
    expect(back).toHaveBeenCalledOnce();
  });

  it("keeps root setup completion distinct from opening Finance", () => {
    const finish = vi.fn();
    const { rerender } = render(
      <FinanceOnboardingComplete
        onFinish={finish}
        busy={false}
        rootSetup
        deferred
      />,
    );
    expect(finish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(finish).toHaveBeenCalledOnce();
    rerender(
      <FinanceOnboardingComplete
        onFinish={finish}
        busy
        rootSetup={false}
        deferred={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Finishing…" }));
    expect(finish).toHaveBeenCalledOnce();
  });
});
