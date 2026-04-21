import { describe, expect, it } from "vitest";

import {
  marketAmbientBackgroundClassName,
  marketCardClassName,
  marketInsetClassName,
  marketMicroSurfaceClassName,
} from "@/components/kai/shared/market-surface-theme";

describe("market surface theme contract", () => {
  it("uses shared surface tokens instead of route-local light gradients", () => {
    expect(marketCardClassName).toContain("var(--app-card-surface-default-solid)");
    expect(marketCardClassName).not.toContain("linear-gradient");
  });

  it("keeps insets on shared compact tokens", () => {
    expect(marketInsetClassName).toContain("var(--app-card-surface-compact)");
    expect(marketInsetClassName).not.toContain("bg-white");
    expect(marketMicroSurfaceClassName).toContain("group-hover:bg-[color:var(--app-card-surface-default-solid)]");
  });

  it("anchors the page backdrop to the app background token", () => {
    expect(marketAmbientBackgroundClassName).toContain("var(--background)");
  });
});
