import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

describe("Empty", () => {
  it("renders root with data-slot='empty'", () => {
    const { container } = render(<Empty />);

    expect(container.querySelector('[data-slot="empty"]')).toBeTruthy();
  });

  it("renders root with role='status'", () => {
    const { container } = render(<Empty />);

    const empty = container.querySelector('[data-slot="empty"]');

    expect(empty?.getAttribute("role")).toBe("status");
  });

  it("renders header with data-slot='empty-header'", () => {
    const { container } = render(
      <Empty>
        <EmptyHeader>Header</EmptyHeader>
      </Empty>,
    );

    expect(
      container.querySelector('[data-slot="empty-header"]'),
    ).toBeTruthy();
  });

  it("renders media with data-slot='empty-icon'", () => {
    const { container } = render(
      <Empty>
        <EmptyMedia>Icon</EmptyMedia>
      </Empty>,
    );

    expect(
      container.querySelector('[data-slot="empty-icon"]'),
    ).toBeTruthy();
  });

  it("renders title with data-slot='empty-title'", () => {
    const { container } = render(
      <Empty>
        <EmptyTitle>No results</EmptyTitle>
      </Empty>,
    );

    expect(
      container.querySelector('[data-slot="empty-title"]'),
    ).toBeTruthy();
  });

  it("renders description with data-slot='empty-description'", () => {
    const { container } = render(
      <Empty>
        <EmptyDescription>Try again later</EmptyDescription>
      </Empty>,
    );

    expect(
      container.querySelector('[data-slot="empty-description"]'),
    ).toBeTruthy();
  });

  it("renders content with data-slot='empty-content'", () => {
    const { container } = render(
      <Empty>
        <EmptyContent>Body</EmptyContent>
      </Empty>,
    );

    expect(
      container.querySelector('[data-slot="empty-content"]'),
    ).toBeTruthy();
  });
});