import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DebateReadinessChart } from "@/components/kai/charts/debate-readiness-chart";

describe("DebateReadinessChart", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
  });

  it("covers readiness score rendering", () => {
    render(
      <DebateReadinessChart
        data={[{ key: "coverage", label: "Coverage", value: 82 }]}
      />,
    );

    expect(screen.getByRole("img", { name: "Coverage: 82%" })).toBeTruthy();
  });
});
