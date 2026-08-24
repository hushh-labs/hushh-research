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

    expect(screen.getByText("Live until Jul 28, 11:19 PM")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.getByText("Trusted A")).toBeTruthy();
    expect(screen.queryByText("Trusted A is sharing with you")).toBeNull();

    const viewButton = screen.getByRole("button", {
      name: "View location",
    });
    expect(
      screen.getByRole("button", {
        name: "Expand shared location from Trusted A",
      }),
    ).toBeTruthy();
    expect(viewButton.getAttribute("aria-expanded")).toBe("false");
    const previewRegion = document.getElementById(
      viewButton.getAttribute("aria-controls") ?? "",
    );
    expect(previewRegion).not.toBeNull();
    expect(previewRegion?.hidden).toBe(true);
    expect(
      screen.queryByRole("button", {
        name: "Recenter map on Trusted A's location",
      }),
    ).toBeNull();

    fireEvent.click(viewButton);
    expect(onView).toHaveBeenCalledTimes(1);

    rerender(
      <SharedWithMeCard {...props} previewExpanded viewBusy>
        <div data-testid="map-preview">Map preview</div>
      </SharedWithMeCard>,
    );

    const hideButton = screen.getByRole("button", {
      name: "Collapse shared location from Trusted A",
    });
    const recenterButton = screen.getByRole("button", {
      name: "Recenter map on Trusted A's location",
    });
    expect(hideButton.getAttribute("aria-expanded")).toBe("true");
    expect(hideButton).not.toBeDisabled();
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

    fireEvent.click(hideButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

/**
 * The card is what a recipient looks at while there is no location on it, and
 * for a long time that was a name, a date, and nothing else. The page computed
 * a reason on every five-second poll; the only thing that rendered it was the
 * retired legacy UI, so the reason never reached anyone.
 *
 * Both tones are asserted because the failure mode runs in both directions: a
 * silent card tells a waiting recipient nothing, and an alarming card tells a
 * recipient on the happy path that something is wrong. The most common status
 * here by far -- the owner has not published a first point yet -- is a success.
 */
describe("SharedWithMeCard view status", () => {
  const base = {
    name: "Trusted A",
    statusLine: "Live until Jul 28, 11:19 PM",
    onView: () => {},
  };

  it("says nothing when there is nothing to say", () => {
    render(<SharedWithMeCard {...base} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Ask to refresh" }),
    ).toBeNull();
  });

  it("reports waiting calmly, with no alert and no recovery action", () => {
    const onAskReshare = vi.fn();
    render(
      <SharedWithMeCard
        {...base}
        viewStatus={{
          message: "Waiting for Trusted A's first update.",
          tone: "waiting",
        }}
        onAskReshare={onAskReshare}
      />,
    );

    expect(screen.getByText("Waiting for their first update…")).toBeTruthy();
    expect(
      screen.queryByText("Waiting for Trusted A's first update."),
    ).toBeNull();
    // A healthy share must never be announced as a problem. `role="alert"`
    // interrupts a screen reader, and amber reads as "something is broken" --
    // both wrong for a share that is working and simply has not been published
    // to yet.
    expect(screen.queryByRole("alert")).toBeNull();
    // Nothing for the recipient to do; the next poll resolves it. Offering
    // "Ask to refresh" here would nag the owner about a share they already made.
    expect(screen.queryByRole("button", { name: "Ask to refresh" })).toBeNull();
    expect(onAskReshare).not.toHaveBeenCalled();
  });

  it("raises a blocked share as an alert and offers the recovery action", () => {
    const onAskReshare = vi.fn();
    render(
      <SharedWithMeCard
        {...base}
        viewStatus={{
          message:
            "Couldn't open Trusted A's live location — the secure key changed. Ask them to share again.",
          tone: "blocked",
        }}
        onAskReshare={onAskReshare}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("the secure key changed");

    const action = screen.getByRole("button", { name: "Ask to refresh" });
    fireEvent.click(action);
    expect(onAskReshare).toHaveBeenCalledTimes(1);
  });

  it("offers no action when the caller supplies none", () => {
    render(
      <SharedWithMeCard
        {...base}
        viewStatus={{ message: "Could not open this share.", tone: "blocked" }}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask to refresh" })).toBeNull();
  });
});
