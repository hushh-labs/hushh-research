// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SaveLocationModal } from "@/components/one-location/onboarding/save-location-modal";

const baseProps = {
  open: true,
  onSave: vi.fn(),
  onSkip: vi.fn(),
};

describe("SaveLocationModal", () => {
  beforeEach(() => {
    baseProps.onSave.mockReset();
    baseProps.onSkip.mockReset();
  });

  it("shows address lookup progress without exposing coordinates", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address={null}
        loadingAddress
      />,
    );

    expect(screen.getByText(/finding your address/i)).toBeInTheDocument();
    expect(screen.queryByText(/12\.9763|77\.5929/)).not.toBeInTheDocument();
  });

  it("shows the friendly address when lookup succeeds", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kasturba Road, Bengaluru, Karnataka 560001, India"
      />,
    );

    expect(
      screen.getByText("Kasturba Road, Bengaluru, Karnataka 560001, India"),
    ).toBeInTheDocument();
  });

  it("uses safe fallback copy instead of raw coordinates", () => {
    render(<SaveLocationModal {...baseProps} address={null} />);

    expect(screen.getByText("Address unavailable")).toBeInTheDocument();
  });

  it("explains the encrypted vault and consent boundary", () => {
    render(<SaveLocationModal {...baseProps} address="Bengaluru, India" />);

    expect(
      screen.getByText(/stays encrypted in your vault/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/shared only when you approve location access/i),
    ).toBeInTheDocument();
  });

  it("requires a category and completed address lookup before saving", () => {
    const { rerender } = render(
      <SaveLocationModal
        {...baseProps}
        address={null}
        loadingAddress
      />,
    );
    const saveButton = screen.getByRole("button", { name: /save location/i });
    expect(saveButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(saveButton).toBeDisabled();

    rerender(
      <SaveLocationModal
        {...baseProps}
        address="Bengaluru, India"
        loadingAddress={false}
      />,
    );
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    expect(baseProps.onSave).toHaveBeenCalledWith("home", "");
  });

  it("saves a custom label for Other", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kasturba Road, Bengaluru"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByLabelText(/give it a name/i), {
      target: { value: "Gym" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save location/i }));

    expect(baseProps.onSave).toHaveBeenCalledWith("other", "Gym");
  });

  it("prevents dismissal while an encrypted save is in flight", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Bengaluru, India"
        saving
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));

    expect(baseProps.onSkip).not.toHaveBeenCalled();
  });
});
