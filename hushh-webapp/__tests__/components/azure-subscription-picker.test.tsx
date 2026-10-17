import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AzureSubscriptionPicker } from "@/components/connections/azure-subscription-picker";
import {
  isAzureSubscriptionId,
  parseAzureAuthorizeCompletion,
} from "@/lib/services/azure-byoc-contract";

const SUBSCRIPTION = "a54ad4fb-0d2d-4d8f-8f43-3e6a1b2c9d10";

describe("Connect Azure for a personal Microsoft account", () => {
  it("reads the hub's personal_account reason and keeps it on the completion", () => {
    const completion = parseAzureAuthorizeCompletion({
      status: "needs_subscription",
      subscriptions: [],
      reason: "personal_account",
    });
    expect(completion).toEqual({
      status: "needs_subscription",
      subscriptions: [],
      reason: "personal_account",
    });
  });

  it("drops a reason it does not know rather than trusting it", () => {
    const completion = parseAzureAuthorizeCompletion({
      status: "needs_subscription",
      subscriptions: [],
      reason: "something-else",
    });
    expect(completion).toEqual({ status: "needs_subscription", subscriptions: [] });
  });

  it("asks for the subscription id instead of claiming there is no subscription", () => {
    const onContinue = vi.fn();
    render(
      <AzureSubscriptionPicker subscriptions={[]} reason="personal_account" onContinue={onContinue} />,
    );
    expect(screen.getByTestId("azure-personal-subscription")).toBeTruthy();
    expect(screen.queryByTestId("azure-no-subscription")).toBeNull();

    const button = screen.getByTestId("azure-subscription-continue") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("azure-subscription-id"), { target: { value: "not-a-guid" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("azure-subscription-id"), {
      target: { value: `  ${SUBSCRIPTION}  ` },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledWith(SUBSCRIPTION);
  });

  it("still tells a work account with no subscription to create one", () => {
    render(<AzureSubscriptionPicker subscriptions={[]} onContinue={vi.fn()} />);
    expect(screen.getByTestId("azure-no-subscription")).toBeTruthy();
    expect(screen.queryByTestId("azure-personal-subscription")).toBeNull();
  });

  it("validates subscription ids as GUIDs", () => {
    expect(isAzureSubscriptionId(SUBSCRIPTION)).toBe(true);
    expect(isAzureSubscriptionId(SUBSCRIPTION.toUpperCase())).toBe(true);
    expect(isAzureSubscriptionId(`${SUBSCRIPTION}x`)).toBe(false);
    expect(isAzureSubscriptionId("")).toBe(false);
  });
});
