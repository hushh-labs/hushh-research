import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SignalChips } from "@/components/kai/home/signal-chips";
import type { KaiHomeSignal } from "@/lib/services/api-service";

const signals: KaiHomeSignal[] = [
  {
    id: "quality-signal",
    title: "Quality holding signal",
    summary: "Quality names are leading the current tape.",
    confidence: 0.82,
    source_tags: ["quality"],
    degraded: false,
  },
  {
    id: "risk-signal",
    title: "Risk-off signal",
    summary: "Risk assets are cooling.",
    confidence: 0.64,
    source_tags: ["risk"],
    degraded: false,
  },
];

describe("SignalChips", () => {
  it("covers selected signal pressed state", () => {
    render(
      <SignalChips
        signals={signals}
        selectedSignalId="quality-signal"
      />,
    );

    expect(
      screen
        .getByRole("button", { name: /quality holding signal/i })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: /risk-off signal/i })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
