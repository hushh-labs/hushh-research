import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

describe("Popover", () => {
  it("renders PopoverTrigger with data-slot='popover-trigger'", () => {
    const { container } = render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
      </Popover>,
    );

    expect(
      container.querySelector('[data-slot="popover-trigger"]'),
    ).toBeTruthy();
  });

  it("renders PopoverContent with data-slot='popover-content' when open", () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content</PopoverContent>
      </Popover>,
    );

    expect(
      document.querySelector('[data-slot="popover-content"]'),
    ).toBeTruthy();
  });

  it("preserves PopoverContent data-slot when className is provided", () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent className="custom-popover-content">
          Content
        </PopoverContent>
      </Popover>,
    );

    const content = document.querySelector('[data-slot="popover-content"]');

    expect(content).toBeTruthy();
    expect(content?.classList.contains("custom-popover-content")).toBe(true);
  });

  it("renders PopoverHeader with data-slot='popover-header'", () => {
    const { container } = render(<PopoverHeader />);

    expect(
      container.querySelector('[data-slot="popover-header"]'),
    ).toBeTruthy();
  });

  it("renders PopoverTitle with data-slot='popover-title'", () => {
    const { container } = render(<PopoverTitle />);

    expect(
      container.querySelector('[data-slot="popover-title"]'),
    ).toBeTruthy();
  });

  it("renders PopoverDescription with data-slot='popover-description'", () => {
    const { container } = render(<PopoverDescription />);

    expect(
      container.querySelector('[data-slot="popover-description"]'),
    ).toBeTruthy();
  });

  it("renders PopoverAnchor with data-slot='popover-anchor'", () => {
    const { container } = render(
      <Popover>
        <PopoverAnchor />
      </Popover>,
    );

    expect(
      container.querySelector('[data-slot="popover-anchor"]'),
    ).toBeTruthy();
  });

});
