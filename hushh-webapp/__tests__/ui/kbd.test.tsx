import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Kbd } from "@/components/ui/kbd";

describe("Kbd", () => {
  it("exposes the kbd data-slot contract", () => {
    const { container } = render(<Kbd>⌘K</Kbd>);

    expect(container.querySelector('[data-slot="kbd"]')).not.toBeNull();
  });
});