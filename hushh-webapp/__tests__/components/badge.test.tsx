import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders with data-slot=badge", () => {
    const { container } = render(<Badge>Label</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("badge");
  });

  it("renders with correct default variant", () => {
    const { container } = render(<Badge>Label</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-variant")).toBe("default");
  });

  it("renders with correct outline variant", () => {
    const { container } = render(<Badge variant="outline">Label</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-variant")).toBe("outline");
  });
});
