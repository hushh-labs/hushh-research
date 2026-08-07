// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mapPickerMockState = vi.hoisted(() => ({
  picked: {
    latitude: 28.614,
    longitude: 77.2091,
    address: "Kartavya Path, New Delhi, Delhi 110001, India",
  },
}));

vi.mock("@/components/one-location/onboarding/location-picker-map", () => ({
  LocationPickerMap: ({
    onConfirm,
    onCancel,
    confirmLabel,
    cancelLabel,
    rendererDisclosureAccepted,
    onAcceptRendererDisclosure,
  }: {
    onConfirm: (picked: {
      latitude: number;
      longitude: number;
      address: string;
    }) => void;
    onCancel: () => void;
    confirmLabel: string;
    cancelLabel: string;
    rendererDisclosureAccepted: boolean;
    onAcceptRendererDisclosure: () => Promise<void>;
  }) => {
    if (!rendererDisclosureAccepted) {
      return (
        <button type="button" onClick={() => void onAcceptRendererDisclosure()}>
          Use Google Maps
        </button>
      );
    }
    return (
      <div aria-label="Mock location picker">
        <button
          type="button"
          onClick={() => onConfirm(mapPickerMockState.picked)}
        >
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    );
  },
}));

import { SaveLocationModal } from "@/components/one-location/onboarding/save-location-modal";

const baseProps = {
  open: true,
  rendererDisclosureAccepted: true,
  onSave: vi.fn(),
  onSkip: vi.fn(),
};

describe("SaveLocationModal", () => {
  beforeEach(() => {
    baseProps.onSave.mockReset();
    baseProps.onSkip.mockReset();
    mapPickerMockState.picked = {
      latitude: 28.614,
      longitude: 77.2091,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
    };
  });

  it("shows address lookup progress without exposing coordinates", () => {
    render(<SaveLocationModal {...baseProps} address={null} loadingAddress />);

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
      <SaveLocationModal {...baseProps} address={null} loadingAddress />,
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
      <SaveLocationModal {...baseProps} address="Kasturba Road, Bengaluru" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByLabelText(/give it a name/i), {
      target: { value: "Gym" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save location/i }));

    expect(baseProps.onSave).toHaveBeenCalledWith("other", "Gym");
  });

  it("atomically changes the captured place through authenticated suggestions", async () => {
    const onSearchPlaces = vi.fn().mockResolvedValue([
      {
        placeId: "office",
        text: "Hushh Office, Bengaluru",
      },
    ]);
    const onSelectPlace = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SaveLocationModal
        {...baseProps}
        address="India Gate, New Delhi"
        onSearchPlaces={onSearchPlaces}
        onSelectPlace={onSelectPlace}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Change captured location" }),
    );
    fireEvent.change(
      screen.getByRole("searchbox", {
        name: "Search for another place",
      }),
      { target: { value: "Hushh Office" } },
    );
    expect(
      screen.getByRole("button", { name: /save location/i }),
    ).toBeDisabled();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Hushh Office, Bengaluru",
      }),
    );
    await waitFor(() => expect(onSelectPlace).toHaveBeenCalledWith("office"));

    rerender(
      <SaveLocationModal
        {...baseProps}
        address="Hushh Office, Bengaluru, Karnataka, India"
        onSearchPlaces={onSearchPlaces}
        onSelectPlace={onSelectPlace}
      />,
    );
    expect(
      screen.getByText("Hushh Office, Bengaluru, Karnataka, India"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/12\.9716|77\.5946/)).not.toBeInTheDocument();
  });

  it("collects an entrance pin and complete address details before saving", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        mapInitial={{ latitude: 28.6139, longitude: 77.209 }}
        onPickExactLocation={vi.fn()}
        startWithMapPicker
        collectAddressDetails
        deferredUntilVault
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Pin your entrance" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

    expect(
      screen.getByRole("dialog", { name: "Add your address details" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Add your address details" }),
    ).toHaveFocus();
    expect(screen.getByLabelText("PIN / postal code")).toHaveValue("110001");
    expect(
      screen.getByText(/kept only for this setup session/i),
    ).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: "Save location" });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("House, flat, floor or block"), {
      target: { value: " Flat 4B, Tower 2 " },
    });
    fireEvent.change(screen.getByLabelText(/Building colour/), {
      target: { value: "Blue gate" },
    });
    fireEvent.change(screen.getByLabelText(/Nearby landmark/), {
      target: { value: "Opposite City Mall" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByLabelText(/Give it a name/i), {
      target: { value: " Parents' home " },
    });

    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    expect(baseProps.onSave).toHaveBeenCalledWith("other", "Parents' home", {
      houseOrFlat: "Flat 4B, Tower 2",
      buildingColor: "Blue gate",
      landmark: "Opposite City Mall",
      postalCode: "110001",
    });
  });

  it("updates the dialog context and focus after renderer disclosure", async () => {
    const acceptRenderer = vi.fn().mockResolvedValue(undefined);
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        mapInitial={{ latitude: 28.6139, longitude: 77.209 }}
        onPickExactLocation={vi.fn()}
        startWithMapPicker
        collectAddressDetails
        rendererDisclosureAccepted={false}
        onAcceptRendererDisclosure={acceptRenderer}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Before Google Maps opens" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Before Google Maps opens" }),
    ).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Use Google Maps" }));

    await waitFor(() => expect(acceptRenderer).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Pin your entrance" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: "Pin your entrance" }),
    ).toHaveFocus();
  });

  it("does not reset entered details when durable renderer consent arrives", () => {
    const props = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      collectAddressDetails: true,
    };
    const { rerender } = render(
      <SaveLocationModal {...props} rendererDisclosureAccepted={false} />,
    );

    fireEvent.change(screen.getByLabelText("House, flat, floor or block"), {
      target: { value: "Flat 4B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    rerender(<SaveLocationModal {...props} rendererDisclosureAccepted />);

    expect(screen.getByLabelText("House, flat, floor or block")).toHaveValue(
      "Flat 4B",
    );
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps an invalid postal code from being submitted", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Address without a postal code"
        collectAddressDetails
      />,
    );

    fireEvent.change(screen.getByLabelText("House, flat, floor or block"), {
      target: { value: "12A" },
    });
    fireEvent.change(screen.getByLabelText("PIN / postal code"), {
      target: { value: "!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    expect(screen.getByLabelText("PIN / postal code")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Save location" }),
    ).toBeDisabled();
    expect(baseProps.onSave).not.toHaveBeenCalled();
  });

  it("refreshes an inferred postal code when the confirmed pin moves", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        mapInitial={{ latitude: 28.6139, longitude: 77.209 }}
        onPickExactLocation={vi.fn()}
        startWithMapPicker
        collectAddressDetails
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    expect(screen.getByLabelText("PIN / postal code")).toHaveValue("110001");

    mapPickerMockState.picked = {
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Kasturba Road, Bengaluru, Karnataka 560001, India",
    };
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

    expect(screen.getByLabelText("PIN / postal code")).toHaveValue("560001");
  });

  it("preserves a manually corrected postal code when the pin moves", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        mapInitial={{ latitude: 28.6139, longitude: 77.209 }}
        onPickExactLocation={vi.fn()}
        startWithMapPicker
        collectAddressDetails
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    fireEvent.change(screen.getByLabelText("PIN / postal code"), {
      target: { value: "110002" },
    });

    mapPickerMockState.picked = {
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Kasturba Road, Bengaluru, Karnataka 560001, India",
    };
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

    expect(screen.getByLabelText("PIN / postal code")).toHaveValue("110002");
  });

  it("restores the inferred postal code when the same modal reopens", () => {
    const props = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      collectAddressDetails: true,
    };
    const { rerender } = render(<SaveLocationModal {...props} />);

    fireEvent.change(screen.getByLabelText("PIN / postal code"), {
      target: { value: "110002" },
    });
    rerender(<SaveLocationModal {...props} open={false} />);
    rerender(<SaveLocationModal {...props} open />);

    expect(screen.getByLabelText("PIN / postal code")).toHaveValue("110001");
  });

  it("maps Escape to the same safe skip action on the map step", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="New Delhi 110001, India"
        mapInitial={{ latitude: 28.6139, longitude: 77.209 }}
        onPickExactLocation={vi.fn()}
        startWithMapPicker
        collectAddressDetails
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Pin your entrance" }),
      { key: "Escape" },
    );

    expect(baseProps.onSkip).toHaveBeenCalledTimes(1);
  });

  it("prevents dismissal while an encrypted save is in flight", () => {
    render(
      <SaveLocationModal {...baseProps} address="Bengaluru, India" saving />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));

    expect(baseProps.onSkip).not.toHaveBeenCalled();
  });
});
