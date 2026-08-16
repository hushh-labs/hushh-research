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

    it("gives each carousel dot a real 44x44 instead of a grown one", () => {
      // Two dots sit side by side, so faking the horizontal region with a
      // `::after` box would overlap them and send an edge tap to the wrong
      // slide. Width therefore stays laid out on both variants.
      render(<SaveLocationModal {...detailProps} />);

      for (const dot of screen.getAllByRole("tab")) {
        expect(dot.className).toContain("h-11");
        expect(dot.className).toContain("w-11");
        expect(dot.className).not.toContain("after:");
      }
    });

    it("shrinks the dots into the sheet grabber on the details slide", () => {
      // In the pinned header they take the grabber's place rather than adding
      // a third stacked row to the footer, so the height comes back through
      // the painted box while the 44px of horizontal separation stays real.
      render(<SaveLocationModal {...detailProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));

      for (const dot of screen.getAllByRole("tab")) {
        expect(dot.className).toContain("w-11");
        expect(dot.className).toContain("h-[18px]");
        expect(dot.className).toContain("after:h-11");
        expect(dot.className).toContain("after:w-11");
      }
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
    // nothing however good the pin is. Blocking the save on a resolved STRING
    // left that person pinned, correct, and permanently unable to finish.
    const strandedProps = {
      ...baseProps,
      address: null,
      collectAddressDetails: true,
    };

    it("asks for one thing it can actually use", () => {
      render(<SaveLocationModal {...strandedProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Home" }));

      expect(
        screen.getByText("Add a house, landmark or PIN."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save location" }),
      ).toBeDisabled();
    });

    it("saves once the person supplies it themselves", () => {
      render(<SaveLocationModal {...strandedProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      fireEvent.change(screen.getByLabelText(/Landmark/), {
        target: { value: "Opposite City Mall" },
      });

      const save = screen.getByRole("button", { name: "Save location" });
      expect(save).toBeEnabled();
      fireEvent.click(save);

      expect(baseProps.onSave).toHaveBeenCalledWith(
        "home",
        "",
        expect.objectContaining({ landmark: "Opposite City Mall" }),
        null,
      );
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
});
