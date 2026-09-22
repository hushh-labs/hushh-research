import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Command, CommandInput } from "@/components/ui/command";
import { Textarea } from "@/components/ui/textarea";

describe("core input geometry", () => {
  it("uses the shared input radius token", () => {
    render(<Input aria-label="Core input" />);

    expect(screen.getByRole("textbox", { name: "Core input" })).toHaveClass(
      "rounded-[var(--app-input-radius)]",
    );
  });

  it("keeps input groups on the same rounded shell", () => {
    render(
      <InputGroup>
        <InputGroupInput aria-label="Grouped input" />
      </InputGroup>,
    );

    expect(screen.getByRole("group")).toHaveClass(
      "rounded-[var(--app-input-radius)]",
    );
  });

  it("uses the shared field radius for multiline entry", () => {
    render(<Textarea aria-label="Core textarea" />);

    expect(screen.getByRole("textbox", { name: "Core textarea" })).toHaveClass(
      "rounded-[var(--app-input-radius)]",
    );
  });

  it("keeps command entry aligned with the field geometry contract", () => {
    render(
      <Command>
        <CommandInput aria-label="Command input" />
      </Command>,
    );

    expect(document.querySelector('[data-slot="command-input"]')).toHaveClass(
      "rounded-[var(--app-input-radius)]",
    );
  });
});
