import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PaginatedListFooter,
  shouldRenderPaginatedListFooter,
} from "@/components/app-ui/paginated-list-footer";

describe("shouldRenderPaginatedListFooter", () => {
  it("returns false if total is 0", () => {
    expect(shouldRenderPaginatedListFooter({ page: 1, limit: 10, total: 0, hasMore: false })).toBe(
      false
    );
  });

  it("returns false on first page if total is under limit and hasMore is false", () => {
    expect(shouldRenderPaginatedListFooter({ page: 1, limit: 10, total: 5, hasMore: false })).toBe(
      false
    );
  });

  it("returns true if there are more pages available", () => {
    expect(shouldRenderPaginatedListFooter({ page: 1, limit: 10, total: 5, hasMore: true })).toBe(
      true
    );
    expect(shouldRenderPaginatedListFooter({ page: 2, limit: 10, total: 15, hasMore: false })).toBe(
      true
    );
  });
});

describe("PaginatedListFooter", () => {
  it("disables navigation controls when movement is unavailable", () => {
    render(
      <PaginatedListFooter
        page={1}
        limit={10}
        total={20}
        hasMore={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: "Go to previous page" }).hasAttribute("disabled")
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Go to next page" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  it("enables controls and registers clicks when navigation is possible", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();

    render(
      <PaginatedListFooter
        page={2}
        limit={10}
        total={30}
        hasMore={true}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    );

    const prevButton = screen.getByRole("button", { name: "Go to previous page" });
    const nextButton = screen.getByRole("button", { name: "Go to next page" });

    expect(prevButton.hasAttribute("disabled")).toBe(false);
    expect(nextButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(prevButton);
    expect(onPrevious).toHaveBeenCalledTimes(1);

    fireEvent.click(nextButton);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("renders page counts and propagates custom class names", () => {
    const { container } = render(
      <PaginatedListFooter
        page={2}
        limit={10}
        total={25}
        hasMore={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        className="custom-paginator"
      />
    );

    expect(screen.getByText("Page 2 of 3")).toBeTruthy();
    expect(container.querySelector(".custom-paginator")).toBeTruthy();
  });
});
