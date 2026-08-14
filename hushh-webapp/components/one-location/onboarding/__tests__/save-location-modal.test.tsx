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
      screen.getByText(/Tag where you are/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/stays encrypted in your vault/i),
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
    expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("110001");
    expect(
      screen.getByText(/Saved after your vault is ready/i),
    ).toBeInTheDocument();
    // The detected address is shown, and the fields below were filled from
    // it -- here only the PIN, since "Kartavya Path" is a street rather than
    // a house number.
    expect(
      screen.getByText("Kartavya Path, New Delhi, Delhi 110001, India"),
    ).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: "Save location" });
    // Still off, but now for the one reason that remains, and it says so.
    expect(saveButton).toBeDisabled();
    expect(screen.getByText("Pick Home, Work or Other first.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
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

    // The address line is passed alongside the details, not folded into them,
    // so the caller composes from parts instead of layering this save on top
    // of whatever the previous one produced.
    expect(baseProps.onSave).toHaveBeenCalledWith(
      "other",
      "Parents' home",
      {
        houseOrFlat: "Flat 4B, Tower 2",
        buildingColor: "Blue gate",
        landmark: "Opposite City Mall",
        postalCode: "110001",
      },
      "Kartavya Path, New Delhi, Delhi 110001, India",
    );
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

    fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
      target: { value: "Flat 4B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    rerender(<SaveLocationModal {...props} rendererDisclosureAccepted />);

    expect(screen.getByLabelText(/House, flat, floor or block/)).toHaveValue(
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

    fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
      target: { value: "12A" },
    });
    fireEvent.change(screen.getByLabelText(/PIN \/ postal code/), {
      target: { value: "!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Save location" }),
    ).toBeDisabled();
    expect(baseProps.onSave).not.toHaveBeenCalled();
  });

  it("saves with just a pinned address, so the button is never dead with nothing to fix", () => {
    // The gate used to require House, flat AND a valid postal code. On the
    // edit flow House, flat came back blank every time, so "Update location"
    // could not be pressed and nothing said why -- which is what "saving
    // address not working" looked like from the outside.
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        collectAddressDetails
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    const saveButton = screen.getByRole("button", { name: "Save location" });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    // "Kartavya Path" is a street, not a house number, so nothing is inferred
    // into House-flat -- and the save still goes through.
    expect(baseProps.onSave).toHaveBeenCalledWith(
      "home",
      "",
      expect.objectContaining({ houseOrFlat: "" }),
      "Kartavya Path, New Delhi, Delhi 110001, India",
    );
  });

  it("says which single thing is missing instead of sitting there dead", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        collectAddressDetails
      />,
    );

    expect(
      screen.getByText("Pick Home, Work or Other first."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save location" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.change(screen.getByLabelText(/PIN \/ postal code/), {
      target: { value: "!" },
    });

    // Distinct from the field's own inline error, which says "Enter a valid
    // PIN or postal code." right beside the input. Two places worth looking,
    // not the same sentence twice.
    expect(
      screen.getByText("Check the PIN or postal code above."),
    ).toBeInTheDocument();
  });

  describe("filling the fields from the detected address", () => {
    const HOUSE_NUMBER_ADDRESS =
      "B-284/3, Rd Number 1, Chhatarpur Enclave Phase 2, New Delhi, Delhi 110074, India";

    it("puts the house number and PIN into their own fields", () => {
      // The address was on screen the whole time and only its postal code was
      // ever mined, so a person looking at "B-284/3, ..." still had to retype
      // B-284/3 into the box directly underneath it.
      render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      expect(screen.getByLabelText(/House, flat, floor or block/)).toHaveValue(
        "B-284/3",
      );
      expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("110074");
      // And the address itself is still shown, as it was before.
      expect(screen.getByText(HOUSE_NUMBER_ADDRESS)).toBeInTheDocument();
    });

    it("leaves House-flat empty when the address opens with a street", () => {
      // A wrong prefill is worse than an empty one: people trust prefilled
      // fields and stop reading them. "12 MG Road" is a street that happens
      // to carry a number, not somebody's flat.
      render(
        <SaveLocationModal
          {...baseProps}
          address="12 MG Road, Bengaluru, Karnataka 560001, India"
          collectAddressDetails
        />,
      );

      expect(screen.getByLabelText(/House, flat, floor or block/)).toHaveValue(
        "",
      );
      expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("560001");
    });

    it("never overwrites a field the person typed in", () => {
      const { rerender } = render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
        target: { value: "Flat 9, Rear block" },
      });

      // A later reverse-geocode arrives. It must not take the field back.
      rerender(
        <SaveLocationModal
          {...baseProps}
          address="C-11/2, Somewhere Else, Delhi 110088, India"
          collectAddressDetails
        />,
      );

      expect(screen.getByLabelText(/House, flat, floor or block/)).toHaveValue(
        "Flat 9, Rear block",
      );
      // The untouched field still follows the pin.
      expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("110088");
    });

    it("clears the filled fields when unticked, and refills them when ticked again", () => {
      render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      const checkbox = screen.getByRole("checkbox", {
        name: /fill the fields below/i,
      });
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);
      expect(screen.getByLabelText(/House, flat, floor or block/)).toHaveValue(
        "",
      );
      expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("");

      fireEvent.click(checkbox);
      expect(screen.getByLabelText(/House, flat, floor or block/)).toHaveValue(
        "B-284/3",
      );
      expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("110074");
    });

    it("does not save the house number twice when it came from the address", () => {
      render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      fireEvent.click(screen.getByRole("button", { name: "Save location" }));

      // The caller composes address + details. Both now carry B-284/3, so the
      // composition has to recognise its own prefill rather than produce
      // "B-284/3, B-284/3, Rd Number 1, ...".
      expect(baseProps.onSave).toHaveBeenCalledWith(
        "home",
        "",
        expect.objectContaining({ houseOrFlat: "B-284/3" }),
        HOUSE_NUMBER_ADDRESS,
      );
    });
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
    expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("110001");

    mapPickerMockState.picked = {
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Kasturba Road, Bengaluru, Karnataka 560001, India",
    };
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

    expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("560001");
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
    fireEvent.change(screen.getByLabelText(/PIN \/ postal code/), {
      target: { value: "110002" },
    });

    mapPickerMockState.picked = {
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Kasturba Road, Bengaluru, Karnataka 560001, India",
    };
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

    expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("110002");
  });

  it("restores the inferred postal code when the same modal reopens", () => {
    const props = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      collectAddressDetails: true,
    };
    const { rerender } = render(<SaveLocationModal {...props} />);

    fireEvent.change(screen.getByLabelText(/PIN \/ postal code/), {
      target: { value: "110002" },
    });
    rerender(<SaveLocationModal {...props} open={false} />);
    rerender(<SaveLocationModal {...props} open />);

    expect(screen.getByLabelText(/PIN \/ postal code/)).toHaveValue("110001");
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
