import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MapPin } from "lucide-react";

import { FeedRow } from "@/components/feed/feed-row";
import type { FeedItem } from "@/lib/services/feed-service";

vi.mock("@/lib/feed/feed-item-renderers", () => ({
  presentFeedItem: (item: FeedItem) => ({
    icon: MapPin,
    domainLabel: "Location",
    label: "Someone shared location",
    description: "A routine location share.",
    href: item.metadata.hrefEnabled ? "/one/location" : null,
    person: item.metadata.person ?? null,
  }),
}));

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "item-1",
    source_domain: "location",
    event_type: "location_share_created",
    actor_label: "A contact",
    metadata: {},
    read: false,
    created_at: "2026-08-12T15:45:00.000Z",
    ...overrides,
  };
}

function pointer(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  id: number,
  x: number,
  y: number,
) {
  // jsdom has no native PointerEvent constructor; preserve MouseEvent coords
  // while supplying the pointer fields React's gesture handler reads.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: "touch" },
    isPrimary: { value: true },
  });
  fireEvent(element, event);
}

describe("FeedRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:50:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the compact feed layout with the local time beside the row copy", () => {
    const { container } = render(<FeedRow item={feedItem()} onOpen={() => {}} />);

    expect(
      screen.getAllByText(/^\d{2}:\d{2}\s?[AP]M$/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("A routine location share.")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="feed-event-time"]')?.parentElement)
      .toHaveClass("items-center");
    expect(screen.getByTestId("feed-row").querySelector("button"))
      .toHaveClass("min-h-[52px]");
  });

  it("never renders the old relative time format", () => {
    render(<FeedRow item={feedItem()} onOpen={() => {}} />);

    expect(screen.queryByText(/^\d+[mhd]$/)).toBeNull();
    expect(screen.queryByText(/^Today -/)).toBeNull();
    expect(screen.queryByText("now")).toBeNull();
  });

  it("uses Connect's same first-and-last initials and photo contract", () => {
    const photo = "https://example.test/profile.png";
    const { container } = render(
      <FeedRow
        item={feedItem({
          metadata: {
            person: { displayName: "Manish Kumar Gupta", photoUrl: photo },
          },
        })}
        onOpen={() => {}}
      />,
    );
    expect(container.querySelector('[data-slot="avatar"]')).toHaveAttribute(
      "data-photo-url",
      photo,
    );
    expect(container.querySelector('[data-slot="avatar"]')).toHaveAttribute(
      "data-avatar-size",
      "compact",
    );
    expect(screen.getByText("MG")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows the unread dot when the item is unread", () => {
    render(<FeedRow item={feedItem({ read: false })} onOpen={() => {}} />);

    expect(screen.getByText("Unread:")).toHaveClass("sr-only");
  });

  it("does not show the unread dot when the item is read", () => {
    render(<FeedRow item={feedItem({ read: true })} onOpen={() => {}} />);

    expect(screen.queryByText("Unread:")).toBeNull();
  });

  it("shows a chevron and opens the item when a href is present", () => {
    const onOpen = vi.fn();
    render(
      <FeedRow
        item={feedItem({ metadata: { hrefEnabled: true } })}
        onOpen={onOpen}
      />,
    );

    screen.getByText("Someone shared location").closest("button")?.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("removes through its callback after a committed left swipe", () => {
    const onRemove = vi.fn();
    const onOpen = vi.fn();
    render(<FeedRow item={feedItem({ metadata: { hrefEnabled: true } })} onOpen={onOpen} onRemove={onRemove} />);
    const row = screen.getByRole("button", { name: /Open Someone shared location/i });

    pointer(row, "pointerdown", 1, 200, 60);
    pointer(row, "pointermove", 1, 100, 63);
    pointer(row, "pointerup", 1, 100, 63);
    fireEvent.click(row);

    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "item-1" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps on right swipe and never commits a cancelled or vertical drag", () => {
    const onRemove = vi.fn();
    const onKeep = vi.fn();
    render(<FeedRow item={feedItem()} onOpen={() => {}} onRemove={onRemove} onKeep={onKeep} />);
    const row = screen.getByRole("button", { name: /Remove Someone shared location/i });

    pointer(row, "pointerdown", 2, 100, 60);
    pointer(row, "pointermove", 2, 200, 63);
    pointer(row, "pointerup", 2, 200, 63);
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onRemove).not.toHaveBeenCalled();

    pointer(row, "pointerdown", 3, 200, 60);
    pointer(row, "pointermove", 3, 100, 63);
    pointer(row, "pointercancel", 3, 100, 63);
    fireEvent.click(row);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    pointer(row, "pointerdown", 4, 200, 60);
    pointer(row, "pointermove", 4, 190, 130);
    pointer(row, "pointerup", 4, 100, 130);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("uses a confirmation for hold and keyboard Delete", () => {
    const onRemove = vi.fn();
    render(<FeedRow item={feedItem()} onOpen={() => {}} onRemove={onRemove} />);
    const row = screen.getByRole("button", { name: /Remove Someone shared location/i });

    pointer(row, "pointerdown", 5, 200, 60);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("alertdialog", { name: "Remove from feed?" })).toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    pointer(row, "pointerup", 5, 200, 60);

    fireEvent.keyDown(row, { key: "Delete" });
    expect(screen.getByRole("alertdialog", { name: "Remove from feed?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
