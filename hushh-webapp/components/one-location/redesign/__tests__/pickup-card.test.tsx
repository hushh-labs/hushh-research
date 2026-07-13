import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SharedWithMeCard } from "@/components/one-location/redesign/cards";

const baseProps = {
  name: "Ankit",
  statusLine: "Expires in 1h",
  onView: vi.fn(),
};

describe("SharedWithMeCard — pickup card", () => {
  it("renders the pickup message and I'm on my way button for a pick_me_up grant", () => {
    const onImOnMyWay = vi.fn();
    render(
      <SharedWithMeCard
        {...baseProps}
        message="I'm at the coffee shop on 5th"
        isPickup
        onImOnMyWay={onImOnMyWay}
        enRoute={false}
      />,
    );

    expect(
      screen.getByText("I'm at the coffee shop on 5th"),
    ).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /i'm on my way/i });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(onImOnMyWay).toHaveBeenCalledTimes(1);
  });

  it("shows En route state instead of button when enRoute is true", () => {
    const onImOnMyWay = vi.fn();
    render(
      <SharedWithMeCard
        {...baseProps}
        message="Pick me up please"
        isPickup
        onImOnMyWay={onImOnMyWay}
        enRoute
      />,
    );

    expect(
      screen.getByText(/en route — sharing your location/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /i'm on my way/i }),
    ).not.toBeInTheDocument();
  });

  it("renders neither message nor pickup button for a non-pickup grant", () => {
    render(
      <SharedWithMeCard
        {...baseProps}
        message={undefined}
        isPickup={false}
        onImOnMyWay={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /i'm on my way/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/en route/i),
    ).not.toBeInTheDocument();
  });

  it("does not show pickup button when isPickup is false even if message provided", () => {
    render(
      <SharedWithMeCard
        {...baseProps}
        message="Some message"
        isPickup={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /i'm on my way/i }),
    ).not.toBeInTheDocument();
  });
});
