import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from "@/components/ui/pagination";

describe("Pagination", () => {
  it("renders root with data-slot='pagination'", () => {
    const { container } = render(
      <Pagination>
        <PaginationContent />
      </Pagination>,
    );

    expect(container.querySelector('[data-slot="pagination"]')).toBeTruthy();
  });

  it("renders root with role='navigation' and aria-label='pagination'", () => {
    const { container } = render(
      <Pagination>
        <PaginationContent />
      </Pagination>,
    );

    const nav = container.querySelector('[data-slot="pagination"]');

    expect(nav?.getAttribute("role")).toBe("navigation");
    expect(nav?.getAttribute("aria-label")).toBe("pagination");
  });

  it("renders content with data-slot='pagination-content'", () => {
    const { container } = render(
      <Pagination>
        <PaginationContent />
      </Pagination>,
    );

    expect(
      container.querySelector('[data-slot="pagination-content"]'),
    ).toBeTruthy();
  });

  it("renders item with data-slot='pagination-item'", () => {
    const { container } = render(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationLink href="#">1</PaginationLink>
          </PaginationItem>
        </PaginationContent>
      </Pagination>,
    );

    expect(
      container.querySelector('[data-slot="pagination-item"]'),
    ).toBeTruthy();
  });

  it("renders link with data-slot='pagination-link' and data-active contract", () => {
    const { container } = render(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationLink href="#" isActive>
              1
            </PaginationLink>
          </PaginationItem>
        </PaginationContent>
      </Pagination>,
    );

    const link = container.querySelector('[data-slot="pagination-link"]');

    expect(link).toBeTruthy();
    expect(link?.getAttribute("data-active")).toBe("true");
  });

  it("renders ellipsis with data-slot='pagination-ellipsis'", () => {
    const { container } = render(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationEllipsis />
          </PaginationItem>
        </PaginationContent>
      </Pagination>,
    );

    expect(
      container.querySelector('[data-slot="pagination-ellipsis"]'),
    ).toBeTruthy();
  });
});