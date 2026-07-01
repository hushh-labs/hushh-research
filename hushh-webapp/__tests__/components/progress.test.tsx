import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "@/components/ui/progress";

describe("Progress", () => {
  it("renders with data-slot=progress", () => {
    const { container } = render(<Progress value={50} />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("progress");
  });

  it("clamps value to 100 when over", () => {
    const { container } = render(<Progress value={150} />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("aria-valuenow")).toBe("100");
  });

  it("clamps value to 0 when negative", () => {
    const { container } = render(<Progress value={-10} />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("aria-valuenow")).toBe("0");
  });
});
