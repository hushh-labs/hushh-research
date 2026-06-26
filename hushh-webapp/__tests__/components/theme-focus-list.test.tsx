import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeFocusList } from "@/components/kai/cards/theme-focus-list";

describe("ThemeFocusList", () => {
  it("renders empty themes fallback", () => {
    render(<ThemeFocusList themes={[]} />);

    expect(
      screen.getByText("No active market themes are available right now."),
    ).toBeTruthy();
  });
});
