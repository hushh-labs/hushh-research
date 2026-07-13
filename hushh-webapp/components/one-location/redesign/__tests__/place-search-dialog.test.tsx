import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { PlaceSearchDialog } from "@/components/one-location/redesign/place-search-dialog";
import { OneLocationService } from "@/lib/one-location/service";
import type { DriveDestination } from "@/lib/one-location/types";

// jsdom shims for Radix Dialog + cmdk.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // @ts-expect-error jsdom lacks pointer capture
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  // @ts-expect-error jsdom lacks pointer capture
  Element.prototype.setPointerCapture = vi.fn();
  // @ts-expect-error jsdom lacks pointer capture
  Element.prototype.releasePointerCapture = vi.fn();
  if (!window.matchMedia) {
    // @ts-expect-error jsdom lacks matchMedia
    window.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  }
  // @ts-expect-error jsdom lacks ResizeObserver
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => vi.clearAllMocks());

describe("PlaceSearchDialog", () => {
  it("searches, returns the selected place, and closes", async () => {
    vi.spyOn(OneLocationService, "placesAutocomplete").mockResolvedValue([
      { placeId: "p1", text: "Indira Gandhi Intl Airport T3" },
    ]);
    vi.spyOn(OneLocationService, "placeDetails").mockResolvedValue({
      placeId: "p1",
      label: "Indira Gandhi Intl Airport T3",
      latitude: 28.55,
      longitude: 77.1,
    } as DriveDestination);
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <PlaceSearchDialog
        open
        onOpenChange={onOpenChange}
        vaultOwnerToken="t"
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/search a place/i), {
      target: { value: "IGI" },
    });

    const result = await screen.findByRole("option", { name: /Indira Gandhi/i });
    fireEvent.click(result);

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: "p1", latitude: 28.55 }),
      ),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows a Recent group when the query is empty", () => {
    const recents: DriveDestination[] = [
      { placeId: "r1", label: "Home", latitude: 1, longitude: 1 },
    ];
    render(
      <PlaceSearchDialog
        open
        onOpenChange={vi.fn()}
        vaultOwnerToken="t"
        recents={recents}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Home/i })).toBeInTheDocument();
  });

  it("prompts to type when empty with no recents", () => {
    render(
      <PlaceSearchDialog
        open
        onOpenChange={vi.fn()}
        vaultOwnerToken="t"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/type to search a place/i)).toBeInTheDocument();
  });
});
