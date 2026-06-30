import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PaginationLink } from "@/components/ui/pagination";

describe("PaginationLink", () => {
  it("renders as anchor element", () => {
    const { container } = render(
      <PaginationLink href="#">
        1
      </PaginationLink>,
    );

    const link = container.querySelector(
      '[data-slot="pagination-link"]',
    );

    expect(link?.tagName).toBe("A");
  });
});