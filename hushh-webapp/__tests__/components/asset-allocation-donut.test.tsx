import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AssetAllocationDonut } from "@/components/kai/charts/asset-allocation-donut";

describe("AssetAllocationDonut", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
  });

  it("covers chart accessible label", () => {
    render(
      <AssetAllocationDonut
        data={[
          { name: "Equities", value: 7500, color: "#2563eb" },
          { name: "Cash", value: 2500, color: "#0ea5e9" },
        ]}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Asset allocation chart" }),
    ).toBeTruthy();
  });
});
