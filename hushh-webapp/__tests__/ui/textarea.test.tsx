import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Textarea } from "@/components/ui/textarea";

describe("Textarea", () => {
  it("renders a disabled textarea", () => {
    const { container } = render(<Textarea disabled />);

    const textarea = container.querySelector("textarea");

    expect(textarea).not.toBeNull();
    expect(textarea?.hasAttribute("disabled")).toBe(true);
  });
});