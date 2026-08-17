// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mapPickerMockState = vi.hoisted(() => ({
  picked: {
    latitude: 28.614,
    longitude: 77.2091,
    address: "Kartavya Path, New Delhi, Delhi 110001, India",
  },
  /** Mirrors a settled pin whose address lookup has finished. */
  canConfirm: true,
}));

const platformMockState = { native: false };

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: () => platformMockState.native,
  getPlatform: () => (platformMockState.native ? "ios" : "web"),
}));

vi.mock("@/components/one-location/onboarding/location-picker-map", async () => {
  const { useEffect, useImperativeHandle } = await import("react");
  return {
    LocationPickerMap: ({
      ref,
      onConfirm,
      onReadyChange,
      onCancel,
      confirmLabel,
      cancelLabel,
      rendererDisclosureAccepted,
      onAcceptRendererDisclosure,
    }: {
      ref?: React.Ref<{ canConfirm: () => boolean; confirm: () => boolean }>;
      onConfirm: (picked: {
        latitude: number;
        longitude: number;
        address: string;
      }) => void;
      onReadyChange?: (ready: boolean) => void;
      onCancel: () => void;
      confirmLabel: string;
      cancelLabel: string;
      rendererDisclosureAccepted: boolean;
      onAcceptRendererDisclosure: () => Promise<void>;
    }) => {
      // The real picker owns the pin, its settle state and its address, so a
      // swipe or a dot tap has to ask it whether it may commit. The mock has
      // to answer the same question or the carousel is untested.
      useImperativeHandle(
        ref,
        () => ({
          canConfirm: () => mapPickerMockState.canConfirm,
          confirm: () => {
            if (!mapPickerMockState.canConfirm) return false;
            onConfirm(mapPickerMockState.picked);
            return true;
          },
        }),
        [onConfirm],
      );
      useEffect(() => {
        onReadyChange?.(mapPickerMockState.canConfirm);
      }, [onReadyChange]);
      if (!rendererDisclosureAccepted) {
        return (
          <button
            type="button"
            onClick={() => void onAcceptRendererDisclosure()}
          >
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
  };
});

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
    mapPickerMockState.canConfirm = true;
  });

  describe("the scrim must not paint over the native map", () => {
    // @capacitor/google-maps draws the map BELOW the WebView and punches a hole
    // through to it. The Radix overlay is a SIBLING of the sheet, so the rule
    // that clears backgrounds inside [data-testid="save-location-modal"] never
    // reached it -- and a 55% black scrim with a 10px blur covered the whole
    // screen. The map was rendering the entire time, behind the scrim: the
    // reported "no map behind it, just one pin" was the HTML pin sitting on top.
    const mapProps = {
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      mapInitial: { latitude: 28.6139, longitude: 77.209 },
      reverseGeocode: vi.fn(),
      onPickExactLocation: vi.fn(),
      startWithMapPicker: true,
      collectAddressDetails: true,
    } as const;

    const overlay = () =>
      document.querySelector('[data-slot="dialog-overlay"]');

    afterEach(() => {
      platformMockState.native = false;
    });

    it("drops the scrim and blur while the native map is on screen", () => {
      platformMockState.native = true;
      render(<SaveLocationModal {...baseProps} {...mapProps} />);

      const className = overlay()?.className ?? "";
      expect(className).toContain("bg-transparent");
      expect(className).not.toMatch(/bg-black\//u);
      expect(className).not.toMatch(/backdrop-blur-\[/u);
    });

    it("keeps the scrim on web, where the map is an ordinary element", () => {
      platformMockState.native = false;
      render(<SaveLocationModal {...baseProps} {...mapProps} />);

      const className = overlay()?.className ?? "";
      expect(className).toMatch(/bg-black\//u);
      expect(className).toContain("backdrop-blur-[10px]");
    });

    it("restores the scrim on native once the map step is left", () => {
      platformMockState.native = true;
      render(
        <SaveLocationModal
          {...baseProps}
          {...mapProps}
          startWithMapPicker={false}
        />,
      );

      // No map on screen, so the sheet gets its normal separation back.
      const className = overlay()?.className ?? "";
      expect(className).toMatch(/bg-black\//u);
    });
  });

  it("opens on Home so the primary button is live without a tap", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        collectAddressDetails
      />,
    );

    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Save location" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Pick Home, Work or Other first."),
    ).not.toBeInTheDocument();
  });

  it("does not pre-select a label that would overwrite a saved place", () => {
    // Home and Work are singletons, so opening on Home for someone who already
    // has one would replace their Home the moment they pressed Save.
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        collectAddressDetails
        existingLocations={[{ category: "home" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "Work" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Save location" }),
    ).toBeEnabled();
  });

  it("still opens live when both singletons are taken", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        collectAddressDetails
        existingLocations={[{ category: "home" }, { category: "work" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "Other" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Save location" }),
    ).toBeEnabled();
  });

  it("keeps the place's own label when editing", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="Kartavya Path, New Delhi, Delhi 110001, India"
        collectAddressDetails
        initialCategory="work"
        existingLocations={[{ category: "home" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "Work" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
      screen.getByText(/stays private to you/i),
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
    fireEvent.change(screen.getByLabelText(/name it/i), {
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
      screen.getByRole("dialog", { name: "Address details" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Address details" }),
    ).toHaveFocus();
    expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("110001");
    expect(
      screen.getByText(/Saves once your lock is set/i),
    ).toBeInTheDocument();
    // The detected address is shown, and the fields below were filled from
    // it -- here only the PIN, since "Kartavya Path" is a street rather than
    // a house number.
    expect(
      screen.getByText("Kartavya Path, New Delhi, Delhi 110001, India"),
    ).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: "Save location" });
    // Live on arrival: nothing is saved yet, so it opens on Home and the one
    // remaining reason to be off no longer applies.
    expect(saveButton).toBeEnabled();
    expect(
      screen.queryByText("Pick Home, Work or Other first."),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/House or flat/), {
      target: { value: " Flat 4B, Tower 2 " },
    });

    // Landmark and building colour are polish, so they start behind a tap.
    expect(screen.getByLabelText(/Building colour/)).not.toBeVisible();
    fireEvent.click(screen.getByTestId("save-location-door-details-toggle"));
    expect(screen.getByLabelText(/Building colour/)).toBeVisible();

    fireEvent.change(screen.getByLabelText(/Building colour/), {
      target: { value: "Blue gate" },
    });
    fireEvent.change(screen.getByLabelText(/Landmark/), {
      target: { value: "Opposite City Mall" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByLabelText(/Name it/i), {
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

    fireEvent.change(screen.getByLabelText(/House or flat/), {
      target: { value: "Flat 4B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    rerender(<SaveLocationModal {...props} rendererDisclosureAccepted />);

    expect(screen.getByLabelText(/House or flat/)).toHaveValue(
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

    fireEvent.change(screen.getByLabelText(/House or flat/), {
      target: { value: "12A" },
    });
    fireEvent.change(screen.getByLabelText(/PIN \/ postcode/), {
      target: { value: "!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveAttribute(
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

    // Home is already selected, so the only way to a dead button now is
    // something the person actually typed.
    expect(
      screen.getByRole("button", { name: "Save location" }),
    ).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/PIN \/ postcode/), {
      target: { value: "!" },
    });

    // Distinct from the field's own inline error, which says "Enter a valid
    // PIN or postal code." right beside the input. Two places worth looking,
    // not the same sentence twice.
    expect(
      screen.getByText("Check the PIN or postcode above."),
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

      expect(screen.getByLabelText(/House or flat/)).toHaveValue(
        "B-284/3",
      );
      expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("110074");
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

      expect(screen.getByLabelText(/House or flat/)).toHaveValue(
        "",
      );
      expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("560001");
    });

    it("never overwrites a field the person typed in", () => {
      const { rerender } = render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      fireEvent.change(screen.getByLabelText(/House or flat/), {
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

      expect(screen.getByLabelText(/House or flat/)).toHaveValue(
        "Flat 9, Rear block",
      );
      // The untouched field still follows the pin.
      expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("110088");
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
        name: /fill from this address/i,
      });
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);
      expect(screen.getByLabelText(/House or flat/)).toHaveValue(
        "",
      );
      expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("");

      fireEvent.click(checkbox);
      expect(screen.getByLabelText(/House or flat/)).toHaveValue(
        "B-284/3",
      );
      expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("110074");
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
    expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("110001");

    mapPickerMockState.picked = {
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Kasturba Road, Bengaluru, Karnataka 560001, India",
    };
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

    expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("560001");
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
    fireEvent.change(screen.getByLabelText(/PIN \/ postcode/), {
      target: { value: "110002" },
    });

    mapPickerMockState.picked = {
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Kasturba Road, Bengaluru, Karnataka 560001, India",
    };
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

    expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("110002");
  });

  it("restores the inferred postal code when the same modal reopens", () => {
    const props = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      collectAddressDetails: true,
    };
    const { rerender } = render(<SaveLocationModal {...props} />);

    fireEvent.change(screen.getByLabelText(/PIN \/ postcode/), {
      target: { value: "110002" },
    });
    rerender(<SaveLocationModal {...props} open={false} />);
    rerender(<SaveLocationModal {...props} open />);

    expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("110001");
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

  describe("the pin and the details as one carousel", () => {
    const carouselProps = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      mapInitial: { latitude: 28.6139, longitude: 77.209 },
      onPickExactLocation: vi.fn(),
      startWithMapPicker: true,
      collectAddressDetails: true,
    };

    /**
     * jsdom's synthetic pointer events carry no coordinates, and a swipe is
     * nothing but coordinates. Dispatching a real MouseEvent under the
     * pointer event's name gives React the clientX/clientY the handler reads.
     */
    const pointer = (
      element: Element,
      type: "pointerdown" | "pointerup",
      x: number,
      y: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      fireEvent(element, event);
    };

    const drag = (element: Element, deltaX: number, deltaY = 0) => {
      pointer(element, "pointerdown", 200, 300);
      pointer(element, "pointerup", 200 + deltaX, 300 + deltaY);
    };

    const swipe = (element: Element, deltaX: number) => drag(element, deltaX);

    it("counts slides with dots instead of announcing extra steps", () => {
      render(<SaveLocationModal {...carouselProps} />);

      expect(screen.queryByText("Step 1 of 2")).not.toBeInTheDocument();
      expect(screen.getAllByRole("tab")).toHaveLength(2);
      expect(
        screen.getByRole("tab", { name: "Pin your entrance" }),
      ).toHaveAttribute("aria-selected", "true");

      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

      expect(screen.queryByText("Step 2 of 2")).not.toBeInTheDocument();
      expect(
        screen.getByRole("tab", { name: "Address details" }),
      ).toHaveAttribute("aria-selected", "true");
    });

    it("moves between slides by swiping", () => {
      render(<SaveLocationModal {...carouselProps} />);
      const sheet = screen.getByTestId("save-location-modal");

      swipe(sheet, -120);
      expect(
        screen.getByRole("dialog", { name: "Address details" }),
      ).toBeInTheDocument();

      swipe(sheet, 120);
      expect(
        screen.getByRole("dialog", { name: "Pin your entrance" }),
      ).toBeInTheDocument();
    });

    it("leaves a gesture that started on the map to the map", () => {
      // Panning to place the pin is a horizontal drag too. Stealing it would
      // make the pin impossible to move.
      render(<SaveLocationModal {...carouselProps} />);
      const sheet = screen.getByTestId("save-location-modal");
      const mapSurface = document.createElement("div");
      mapSurface.setAttribute("data-location-picker-surface", "");
      sheet.appendChild(mapSurface);

      swipe(mapSurface, -120);

      expect(
        screen.getByRole("dialog", { name: "Pin your entrance" }),
      ).toBeInTheDocument();
    });

    it("ignores a short drag and a vertical scroll", () => {
      render(<SaveLocationModal {...carouselProps} />);
      const sheet = screen.getByTestId("save-location-modal");

      swipe(sheet, -30);
      expect(
        screen.getByRole("dialog", { name: "Pin your entrance" }),
      ).toBeInTheDocument();

      drag(sheet, -80, 300);
      expect(
        screen.getByRole("dialog", { name: "Pin your entrance" }),
      ).toBeInTheDocument();
    });

    it("commits the pin when the second dot is tapped", () => {
      const onPickExactLocation = vi.fn();
      render(
        <SaveLocationModal
          {...carouselProps}
          onPickExactLocation={onPickExactLocation}
        />,
      );

      fireEvent.click(screen.getByRole("tab", { name: "Address details" }));

      expect(onPickExactLocation).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("dialog", { name: "Address details" }),
      ).toBeInTheDocument();
    });

    it("will not advance while the pin is still settling", () => {
      mapPickerMockState.canConfirm = false;
      render(<SaveLocationModal {...carouselProps} />);

      expect(
        screen.getByRole("tab", { name: "Address details" }),
      ).toBeDisabled();

      swipe(screen.getByTestId("save-location-modal"), -120);
      expect(
        screen.getByRole("dialog", { name: "Pin your entrance" }),
      ).toBeInTheDocument();
    });
  });

  describe("controls stay tappable without moving", () => {
    const detailProps = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      mapInitial: { latitude: 28.6139, longitude: 77.209 },
      onPickExactLocation: vi.fn(),
      startWithMapPicker: true,
      collectAddressDetails: true,
    };

    it("lays the details header's controls out beside the title instead of over it", () => {
      // These used to be `absolute left-4/right-4 top-4` over a header padded
      // to `px-9`. A 36px button starting at 16px ends at 52px, so it covered
      // the title -- and because the sheet itself was the scroller, the two
      // drifted apart the moment anyone scrolled. A flex row cannot overlap
      // itself. `e2e/save-location-sheet.layout.spec.ts` measures it.
      render(<SaveLocationModal {...detailProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

      const header = screen
        .getByRole("heading", { name: "Address details" })
        .closest("header");
      expect(header).not.toBeNull();

      for (const name of ["Back to map", "Close"]) {
        const button = screen.getByRole("button", { name });
        expect(header!.contains(button)).toBe(true);
        expect(button.className).not.toMatch(/(^|\s)absolute(\s|$)/);
        // The hit area is still grown with a painted `::after` box, and the
        // painted circle is unchanged.
        expect(button.className).toContain("after:h-11");
        expect(button.className).toContain("after:w-11");
        expect(button.className).toContain("h-9");
        expect(button.className).toContain("w-9");
      }
    });

    it("gives each carousel dot a real 44x44 without overlapping its neighbour", () => {
      // Two dots sit side by side, so faking the HORIZONTAL region with a
      // `::after` box would overlap them and send an edge tap to the wrong
      // slide. Width therefore stays laid out. Height is the half that may be
      // painted: the rail is 18px so the pinned header stays a header, and
      // the remaining vertical target comes back through the ::after box.
      render(<SaveLocationModal {...detailProps} />);

      for (const dot of screen.getAllByRole("tab")) {
        expect(dot.className).toContain("w-11");
        expect(dot.className).toContain("h-[18px]");
        expect(dot.className).toContain("after:h-11");
        expect(dot.className).toContain("after:w-11");
      }
    });

    it("renders one indicator, the same size, on every slide", () => {
      // #5396. The rail used to be 44px tall at the BOTTOM of the map slide
      // and 18px tall at the TOP of the details slide, so it appeared to move
      // and resize as the person advanced through two steps.
      render(<SaveLocationModal {...detailProps} />);
      const geometryOf = () =>
        screen.getAllByRole("tab").map((dot) => {
          const cls = dot.className;
          return [
            /h-\[18px\]/u.test(cls),
            /\bw-11\b/u.test(cls),
            /after:h-11/u.test(cls),
          ].join("|");
        });

      const onMapSlide = geometryOf();
      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
      const onDetailsSlide = geometryOf();

      expect(onMapSlide).toEqual(["true|true|true", "true|true|true"]);
      expect(onDetailsSlide).toEqual(onMapSlide);
    });

    it("tells a finished step apart from one not reached yet", () => {
      // There were only two visual states, so on the second slide the step
      // already completed looked exactly like a step never reached. Colour
      // now says "reached", width says "you are here".
      render(<SaveLocationModal {...detailProps} />);

      expect(
        screen.getAllByRole("tab").map((d) => d.getAttribute("data-step-state")),
      ).toEqual(["active", "upcoming"]);

      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

      expect(
        screen.getAllByRole("tab").map((d) => d.getAttribute("data-step-state")),
      ).toEqual(["completed", "active"]);
    });

    it("keeps an upcoming step visible instead of a 1.27:1 ghost", () => {
      // The inactive pill was --app-neutral-fill-strong, which composites to
      // #E4E4E6 on the white sheet (1.27:1) and #47474C on the dark one
      // (1.51:1) — under the 3:1 WCAG 2.2 SC 1.4.11 asks of a state control.
      // #8E8E93 clears it on BOTH surfaces (3.26:1 / 4.27:1).
      //
      // jsdom cannot prove a rendered pixel; the paired real-browser
      // measurement is in e2e/save-location-sheet.layout.spec.ts.
      render(<SaveLocationModal {...detailProps} />);

      const upcoming = screen
        .getAllByRole("tab")
        .find((d) => d.getAttribute("data-step-state") === "upcoming");
      const pill = upcoming?.querySelector("span");
      expect(pill?.className).toContain("bg-[#8E8E93]");
      expect(pill?.className).not.toContain("--app-neutral-fill-strong");
    });
  });

  describe("the details sheet is a frame, not one long scroll box", () => {
    const detailProps = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      mapInitial: { latitude: 28.6139, longitude: 77.209 },
      onPickExactLocation: vi.fn(),
      startWithMapPicker: true,
      collectAddressDetails: true,
    };

    it("scrolls the body only, so the pinned rows cannot be scrolled past", () => {
      render(<SaveLocationModal {...detailProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

      const sheet = screen.getByTestId("save-location-modal");
      // `overflow-y-hidden`, not `overflow-hidden`: tailwind-merge files those
      // under different keys, so the primitive's own `overflow-y-auto` would
      // survive and the whole sheet would keep scrolling behind the header.
      expect(sheet.className).toContain("overflow-y-hidden");
      expect(sheet.className).not.toContain("overflow-y-auto");

      const save = screen.getByRole("button", { name: /Save location/ });
      const footer = save.parentElement!;
      const scroller = footer.previousElementSibling as HTMLElement;
      expect(scroller.className).toContain("overflow-y-auto");
      expect(scroller.className).toContain("flex-1");
      expect(scroller.className).toContain("min-h-0");

      // The last field belongs to the scroller, and the primary action does
      // not -- which is what stops content bleeding under the button.
      expect(scroller.contains(screen.getByLabelText(/Landmark/))).toBe(true);
      expect(scroller.contains(save)).toBe(false);
    });

    it("puts the pinned footer on a solid surface", () => {
      // It used to be `sticky bottom-0` on a `/95` background, so the field
      // underneath showed through the button.
      render(<SaveLocationModal {...detailProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

      const footer = screen.getByRole("button", { name: /Save location/ })
        .parentElement!;
      expect(footer.className).toContain(
        "bg-[color:var(--app-card-surface-default-solid)]",
      );
      expect(footer.className).not.toContain("/95");
      expect(footer.className).not.toContain("sticky");
      expect(footer.className).toContain("shrink-0");
    });
  });

  describe("the sheet reads as a layer, not a patch", () => {
    it("puts its scrim above the full-screen onboarding takeover", () => {
      // Location onboarding is an OPAQUE fixed layer at z-560. The scrim used
      // to sit at z-559, underneath it, so the dim and the blur were painted
      // where nothing could see them and the sheet landed on a fully lit
      // screen with no separation at all.
      render(
        <SaveLocationModal {...baseProps} address="Bengaluru, India" />,
      );

      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      const sheet = screen.getByTestId("save-location-modal");
      const layerOf = (element: Element | null) =>
        Number(
          /z-\[(\d+)\]/.exec(element?.className?.toString() ?? "")?.[1] ?? "0",
        );

      expect(layerOf(overlay)).toBeGreaterThan(560);
      expect(layerOf(sheet)).toBeGreaterThan(layerOf(overlay));
      expect(overlay?.className).toContain("backdrop-blur");
    });
  });

  describe("the primary button only looks live when it is", () => {
    it("goes neutral while it cannot take you forward", () => {
      render(
        <SaveLocationModal
          {...baseProps}
          address="Kartavya Path, New Delhi, Delhi 110001, India"
          collectAddressDetails
        />,
      );

      // It now opens live, so block it the only way left -- something the
      // person typed -- and check the styling follows the state.
      const save = screen.getByRole("button", { name: "Save location" });
      expect(save).toBeEnabled();
      expect(save.className).toContain("var(--app-accent)");

      // A dimmed blue still reads as the live primary action and earns a dead
      // tap, so a blocked CTA must not be blue at all.
      fireEvent.change(screen.getByLabelText(/PIN \/ postcode/), {
        target: { value: "!" },
      });
      expect(save).toBeDisabled();
      expect(save.className).not.toContain("var(--app-accent)");

      fireEvent.change(screen.getByLabelText(/PIN \/ postcode/), {
        target: { value: "110001" },
      });
      expect(save).toBeEnabled();
      expect(save.className).toContain("var(--app-accent)");
    });
  });

  describe("when the pin is good but no address comes back", () => {
    // On the native build before the vault exists there is no server
    // reverse-geocode and no browser geocoder either, so the lookup returns
    // nothing however good the pin is. Requiring the address is safe anyway,
    // because the way out is the Address box itself: it is editable and it is
    // already on screen, so that person types the line and finishes.
    const strandedProps = {
      ...baseProps,
      address: null,
      collectAddressDetails: true,
    };

    it("says what is missing beside the box, not only on the button", () => {
      render(<SaveLocationModal {...strandedProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Home" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter the address.");
      expect(screen.getByLabelText(/^Address$/)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      expect(screen.getByText("Add the address above.")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save location" }),
      ).toBeDisabled();
    });

    it("does not take door details in place of the address", () => {
      render(<SaveLocationModal {...strandedProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      fireEvent.click(screen.getByTestId("save-location-door-details-toggle"));
      fireEvent.change(screen.getByLabelText(/Landmark/), {
        target: { value: "Opposite City Mall" },
      });
      fireEvent.change(screen.getByLabelText(/PIN \/ postcode/), {
        target: { value: "110001" },
      });

      // The field is marked required, so it has to actually BE required --
      // a badge over a gate that anything else can open is a lie.
      expect(
        screen.getByRole("button", { name: "Save location" }),
      ).toBeDisabled();
      expect(baseProps.onSave).not.toHaveBeenCalled();
    });

    it("unblocks the save once the person types an address line themselves", () => {
      render(<SaveLocationModal {...strandedProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Home" }));

      expect(
        screen.getByRole("button", { name: "Save location" }),
      ).toBeDisabled();

      fireEvent.change(screen.getByLabelText(/^Address$/), {
        target: { value: "12 MG Road, Bengaluru" },
      });

      const save = screen.getByRole("button", { name: "Save location" });
      expect(save).toBeEnabled();
      fireEvent.click(save);

      expect(baseProps.onSave).toHaveBeenCalledWith(
        "home",
        "",
        expect.anything(),
        "12 MG Road, Bengaluru",
      );
    });
  });

  describe("the Address box", () => {
    const HOUSE_NUMBER_ADDRESS =
      "B-284/3, Rd Number 1, Chhatarpur Enclave Phase 2, New Delhi, Delhi 110074, India";

    it("auto-populates from the detected address", () => {
      render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      expect(screen.getByLabelText(/^Address$/)).toHaveValue(
        HOUSE_NUMBER_ADDRESS,
      );
    });

    it("keeps what the person typed instead of the address that arrives later", () => {
      const { rerender } = render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      fireEvent.change(screen.getByLabelText(/^Address$/), {
        target: { value: "My corrected street address" },
      });

      // A later reverse-geocode (or a repicked pin) must not take it back.
      rerender(
        <SaveLocationModal
          {...baseProps}
          address="C-11/2, Somewhere Else, Delhi 110088, India"
          collectAddressDetails
        />,
      );

      expect(screen.getByLabelText(/^Address$/)).toHaveValue(
        "My corrected street address",
      );
    });

    it("saves the typed address line, not the raw detected address", () => {
      render(
        <SaveLocationModal
          {...baseProps}
          address={HOUSE_NUMBER_ADDRESS}
          collectAddressDetails
        />,
      );

      fireEvent.change(screen.getByLabelText(/^Address$/), {
        target: { value: "My corrected street address" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      fireEvent.click(screen.getByRole("button", { name: "Save location" }));

      expect(baseProps.onSave).toHaveBeenCalledWith(
        "home",
        "",
        expect.anything(),
        "My corrected street address",
      );
    });
  });

  it("shows a plus-code address without the plus code", () => {
    render(
      <SaveLocationModal
        {...baseProps}
        address="FVJ7+JR2, Teliarganj, Prayagraj, Uttar Pradesh 211004, India"
        collectAddressDetails
      />,
    );

    expect(
      screen.getByText("Teliarganj, Prayagraj, Uttar Pradesh 211004, India"),
    ).toBeInTheDocument();
    // And it is not offered as a house number.
    expect(screen.getByLabelText(/House or flat/)).toHaveValue("");
    expect(screen.getByLabelText(/PIN \/ postcode/)).toHaveValue("211004");
  });

  describe("the Address box is required, and says so", () => {
    const detailsProps = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      collectAddressDetails: true,
    };

    it("marks it required on screen and to a screen reader", () => {
      render(<SaveLocationModal {...detailsProps} />);

      const address = screen.getByLabelText(/^Address$/);
      expect(address).toBeRequired();
      expect(address).toHaveAttribute("aria-required", "true");
      // The word, so the requirement does not rest on seeing a colour. Kept
      // out of the label element, or it would join the field's own name.
      expect(screen.getByText("Required")).toBeInTheDocument();
      expect(address).toHaveAccessibleName("Address");
      expect(screen.getByText("Used to find your door.")).toBeInTheDocument();
    });

    it("stays quiet while the box holds the detected address", () => {
      render(<SaveLocationModal {...detailsProps} />);

      expect(screen.queryByText("Enter the address.")).not.toBeInTheDocument();
      expect(screen.getByLabelText(/^Address$/)).toHaveAttribute(
        "aria-invalid",
        "false",
      );
      expect(
        screen.getByRole("button", { name: "Save location" }),
      ).toBeEnabled();
    });

    it("waits until the person leaves the box before calling their edit wrong", () => {
      render(<SaveLocationModal {...detailsProps} />);
      const address = screen.getByLabelText(/^Address$/);

      // Clearing the line to retype it must not flash an error per keystroke.
      fireEvent.change(address, { target: { value: "" } });
      expect(screen.queryByText("Enter the address.")).not.toBeInTheDocument();

      fireEvent.blur(address);
      expect(screen.getByText("Enter the address.")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save location" }),
      ).toBeDisabled();

      fireEvent.change(address, { target: { value: "12 MG Road, Bengaluru" } });
      expect(screen.queryByText("Enter the address.")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save location" }),
      ).toBeEnabled();
    });

    it("points the box at its help line, and then at its error too", () => {
      render(<SaveLocationModal {...detailsProps} />);
      const address = screen.getByLabelText(/^Address$/);
      const help = screen.getByText("Used to find your door.");
      expect(address.getAttribute("aria-describedby")).toBe(help.id);

      fireEvent.change(address, { target: { value: "" } });
      fireEvent.blur(address);

      const error = screen.getByText("Enter the address.");
      expect(address.getAttribute("aria-describedby")?.split(" ")).toEqual([
        help.id,
        error.id,
      ]);
    });
  });

  describe("the order the details are asked in", () => {
    const detailsProps = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      collectAddressDetails: true,
    };

    const isBefore = (first: Element, second: Element) =>
      Boolean(
        first.compareDocumentPosition(second) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );

    it("asks the two things a save needs before anything optional", () => {
      render(<SaveLocationModal {...detailsProps} />);

      const address = screen.getByLabelText(/^Address$/);
      const kindOfPlace = screen.getByRole("group", {
        name: "Saved location category",
      });
      const optionalGroup = screen.getByText("Optional — helps at the door.");
      const houseOrFlat = screen.getByLabelText(/House or flat/);
      const doorDetails = screen.getByTestId(
        "save-location-door-details-toggle",
      );
      const buildingColour = screen.getByLabelText(/Building colour/);

      expect(isBefore(address, kindOfPlace)).toBe(true);
      expect(isBefore(kindOfPlace, optionalGroup)).toBe(true);
      expect(isBefore(optionalGroup, houseOrFlat)).toBe(true);
      expect(isBefore(houseOrFlat, doorDetails)).toBe(true);
      expect(isBefore(doorDetails, buildingColour)).toBe(true);
    });

    it("keeps building colour behind a tap for a new place", () => {
      render(<SaveLocationModal {...detailsProps} />);

      expect(screen.getByLabelText(/Building colour/)).not.toBeVisible();
      expect(screen.getByLabelText(/Landmark/)).not.toBeVisible();
      expect(
        screen.getByTestId("save-location-door-details-toggle"),
      ).toHaveAttribute("aria-expanded", "false");
    });

    it("opens it when the place already carries those answers", () => {
      render(
        <SaveLocationModal
          {...detailsProps}
          initialDetails={{
            houseOrFlat: "",
            buildingColor: "Blue gate",
            landmark: "",
            postalCode: "",
          }}
        />,
      );

      expect(screen.getByLabelText(/Building colour/)).toBeVisible();
      expect(
        screen.getByTestId("save-location-door-details-toggle"),
      ).toHaveAttribute("aria-expanded", "true");
    });

    it("does not lose what was typed when the step is collapsed again", () => {
      render(<SaveLocationModal {...detailsProps} />);
      const toggle = screen.getByTestId("save-location-door-details-toggle");

      fireEvent.click(toggle);
      fireEvent.change(screen.getByLabelText(/Building colour/), {
        target: { value: "Blue gate" },
      });
      fireEvent.click(toggle);
      fireEvent.click(toggle);

      expect(screen.getByLabelText(/Building colour/)).toHaveValue("Blue gate");
    });
  });

  describe("on a phone it is the app's own bottom sheet", () => {
    const sheetProps = {
      ...baseProps,
      address: "Kartavya Path, New Delhi, Delhi 110001, India",
      collectAddressDetails: true,
    };

    /** jsdom has no layout, so the width is whatever matchMedia says it is. */
    const setPhoneWidth = (phone: boolean) => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: phone && query === "(max-width: 639.98px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    };

    /**
     * jsdom's synthetic pointer events carry no coordinates, and a pull is
     * nothing but coordinates.
     */
    const pointer = (
      element: Element,
      type: "pointerdown" | "pointermove" | "pointerup",
      x: number,
      y: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      fireEvent(element, event);
    };

    afterEach(() => setPhoneWidth(false));

    it("renders in the shared sheet primitive, not in a dialog", () => {
      setPhoneWidth(true);
      render(<SaveLocationModal {...sheetProps} />);

      expect(screen.getByTestId("save-location-modal")).toHaveAttribute(
        "data-slot",
        "sheet-content",
      );
      expect(
        document.querySelector('[data-slot="sheet-overlay"]'),
      ).toBeInTheDocument();
    });

    it("keeps the centred dialog above that width", () => {
      setPhoneWidth(false);
      render(<SaveLocationModal {...sheetProps} />);

      expect(screen.getByTestId("save-location-modal")).toHaveAttribute(
        "data-slot",
        "dialog-content",
      );
      expect(
        document.querySelector('[data-slot="sheet-overlay"]'),
      ).not.toBeInTheDocument();
    });

    it("closes on a pull down from the grabber row", async () => {
      setPhoneWidth(true);
      const onSkip = vi.fn();
      render(<SaveLocationModal {...sheetProps} onSkip={onSkip} />);

      const grabber = screen.getByTestId("save-location-sheet-grabber");
      pointer(grabber, "pointerdown", 200, 100);
      pointer(grabber, "pointermove", 200, 340);
      pointer(grabber, "pointerup", 200, 340);

      await waitFor(() => expect(onSkip).toHaveBeenCalled());
    });

    it("ignores a pull too short to be one", async () => {
      setPhoneWidth(true);
      const onSkip = vi.fn();
      render(<SaveLocationModal {...sheetProps} onSkip={onSkip} />);

      const grabber = screen.getByTestId("save-location-sheet-grabber");
      pointer(grabber, "pointerdown", 200, 100);
      pointer(grabber, "pointermove", 200, 140);
      pointer(grabber, "pointerup", 200, 140);

      await new Promise((resolve) => setTimeout(resolve, 320));
      expect(onSkip).not.toHaveBeenCalled();
    });

    it("leaves a press on a dot to the dot", async () => {
      setPhoneWidth(true);
      const onSkip = vi.fn();
      render(
        <SaveLocationModal
          {...sheetProps}
          mapInitial={{ latitude: 28.6139, longitude: 77.209 }}
          onPickExactLocation={vi.fn()}
          startWithMapPicker
          onSkip={onSkip}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

      const dot = screen.getByRole("tab", { name: "Pin your entrance" });
      pointer(dot, "pointerdown", 200, 100);
      pointer(dot, "pointermove", 200, 340);
      pointer(dot, "pointerup", 200, 340);

      await new Promise((resolve) => setTimeout(resolve, 320));
      expect(onSkip).not.toHaveBeenCalled();
    });
  });
});
