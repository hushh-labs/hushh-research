import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { EmergencySmsNotificationToast } from "@/components/one-location/emergency-sms-notification-toast";

function renderToast(
  props: Partial<
    React.ComponentProps<typeof EmergencySmsNotificationToast>
  > = {},
) {
  return render(
    <EmergencySmsNotificationToast
      title="Carol needs help"
      description="I'm not safe"
      onOpen={vi.fn()}
      {...props}
    />,
  );
}

describe("EmergencySmsNotificationToast last-known location line", () => {
  it("always renders the alert title, message, and View live location action", () => {
    renderToast();
    expect(screen.getByText("Carol needs help")).toBeInTheDocument();
    expect(screen.getByText("I'm not safe")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /View live location/i }),
    ).toBeInTheDocument();
  });

  it("renders the resolved last-known address", () => {
    renderToast({ address: "5th Ave, New York, NY" });
    expect(screen.getByText("5th Ave, New York, NY")).toBeInTheDocument();
  });

  it("falls back to raw coordinates when no address is available", () => {
    const { container } = renderToast({
      coordinatesFallback: "10.7904° N, 78.7047° E",
    });
    expect(screen.getByText("10.7904° N, 78.7047° E")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("shows a skeleton while the address is resolving and none is available yet", () => {
    const { container } = renderToast({
      addressLoading: true,
      coordinatesFallback: "10.7904° N, 78.7047° E",
    });
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(
      screen.queryByText("10.7904° N, 78.7047° E"),
    ).not.toBeInTheDocument();
  });

  it("prefers a resolved address over the skeleton even while still loading", () => {
    const { container } = renderToast({
      address: "5th Ave, New York, NY",
      addressLoading: true,
      coordinatesFallback: "10.7904° N, 78.7047° E",
    });
    expect(screen.getByText("5th Ave, New York, NY")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("renders no location line when no address, loading, or coordinates are given", () => {
    const { container } = renderToast();
    // The only animated element is the Siren ping, never an address skeleton.
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.queryByText(/° [NS],/)).not.toBeInTheDocument();
  });
});
