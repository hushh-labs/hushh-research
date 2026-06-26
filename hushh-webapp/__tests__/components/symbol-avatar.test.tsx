import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";

describe("SymbolAvatar", () => {
  it("renders fallback initials when logo loading fails", () => {
    const { container } = render(<SymbolAvatar symbol="NVDA" name="Nvidia" />);

    const logo = container.querySelector("img");
    expect(logo).toBeTruthy();
    fireEvent.error(logo!);

    expect(screen.getByText("N")).toBeTruthy();
  });
});
