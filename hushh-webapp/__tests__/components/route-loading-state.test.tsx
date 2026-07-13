import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";

describe("RouteLoadingState", () => {
  it("uses the app shell for authenticated route fallbacks", () => {
    const { container } = render(<RouteLoadingState label="Opening One…" />);

    expect(
      container.querySelector("[data-route-loading-surface='app']"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-app-shell-width='standard']"),
    ).not.toBeNull();
    expect(screen.getByRole("status", { name: "Opening One…" })).toBeTruthy();
  });

  it("uses the fullscreen-flow shell for onboarding", () => {
    const { container } = render(
      <RouteLoadingState surface="onboarding" label="Preparing sign in…" />,
    );

    expect(
      container.querySelector("[data-route-loading-surface='onboarding']"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-fullscreen-flow-shell='true']"),
    ).not.toBeNull();
  });

  it("uses a neutral full canvas for public ambient routes", () => {
    const { container } = render(
      <RouteLoadingState surface="ambient" label="Loading page…" />,
    );

    expect(
      container.querySelector("[data-route-loading-surface='ambient']"),
    ).not.toBeNull();
    expect(screen.getByRole("status", { name: "Loading page…" })).toBeTruthy();
  });
});
