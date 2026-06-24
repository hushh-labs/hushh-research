import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Textarea } from "@/components/ui/textarea";

describe("Textarea", () => {
  it("exposes the textarea data-slot contract", () => {
    const { container } = render(<Textarea />);

    expect(container.querySelector('[data-slot="textarea"]')).not.toBeNull();
  });
});