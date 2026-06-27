import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";

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
      />,
    );

    expect(
      screen.getByRole("button", { name: "Go to previous page" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Go to next page" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
  });
});
