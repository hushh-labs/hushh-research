import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SharedWithMeCard } from "@/components/one-location/redesign/cards";

describe("SharedWithMeCard", () => {
  it("keeps the live state beside the expiry and exposes an accessible disclosure", () => {
    const onView = vi.fn();
    const onDismiss = vi.fn();
    const onRecenter = vi.fn();
    const props = {
      name: "Trusted A",
      statusLine: "Live until Jul 28, 11:19 PM",
      onView,
      onDismiss,
      onRecenter,
      mapHref: "https://www.google.com/maps/search/?api=1&query=1%2C2",
    };
    const { rerender } = render(
      <SharedWithMeCard {...props} previewExpanded={false}>
        <div data-testid="map-preview">Map preview</div>
      </SharedWithMeCard>,
    );

    const activePill = screen.getByText("Active");
    expect(activePill.parentElement?.textContent).toContain(
      "Live until Jul 28, 11:19 PMActive",
    );
    expect(screen.getByText("Trusted A")).toBeTruthy();
    expect(screen.queryByText("Trusted A is sharing with you")).toBeNull();

    const expandButton = screen.getByRole("button", {
      name: "Expand shared location from Trusted A",
    });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    const previewRegion = document.getElementById(
      expandButton.getAttribute("aria-controls") ?? "",
    );
    expect(previewRegion).not.toBeNull();
    expect(previewRegion?.hidden).toBe(true);
    expect(
      screen.queryByRole("button", {
        name: "Recenter map on Trusted A's location",
      }),
    ).toBeNull();

    fireEvent.click(expandButton);
    expect(onView).toHaveBeenCalledTimes(1);

    rerender(
      <SharedWithMeCard {...props} previewExpanded viewBusy>
        <div data-testid="map-preview">Map preview</div>
      </SharedWithMeCard>,
    );

    const collapseButton = screen.getByRole("button", {
      name: "Collapse shared location from Trusted A",
    });
    const recenterButton = screen.getByRole("button", {
      name: "Recenter map on Trusted A's location",
    });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    expect(collapseButton).not.toBeDisabled();
    expect(
      recenterButton.compareDocumentPosition(collapseButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(previewRegion?.hidden).toBe(false);
    expect(
      screen.getByRole("link", {
        name: "Open shared location in Google Maps",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    fireEvent.click(recenterButton);
    expect(onRecenter).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(collapseButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
