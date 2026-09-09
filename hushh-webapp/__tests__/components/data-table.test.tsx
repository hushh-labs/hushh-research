import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/app-ui/data-table";

type TestRow = {
  id: number;
  name: string;
};

const columns: ColumnDef<TestRow>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => row.original.name,
  },
];

function makeRows(count: number): TestRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Row ${index + 1}`,
  }));
}

describe("DataTable", () => {
  it("supports direct page-number navigation", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(30)}
        enableSearch={false}
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
      />,
    );

    expect(screen.getByText("Row 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("Row 9")).toBeTruthy();
    expect(screen.queryByText("Row 1")).toBeNull();
  });

  it("keeps range and page navigation in their paired footer control groups", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(30)}
        enableSearch={false}
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
      />,
    );

    const rangeControls = document.querySelector(
      '[data-slot="data-table-range-controls"]',
    );
    const pageControls = document.querySelector(
      '[data-slot="data-table-page-controls"]',
    );

    expect(rangeControls?.textContent).toContain("8");
    expect(rangeControls?.textContent).toContain("Showing 1-8 of 30");
    expect(rangeControls).toHaveClass("w-full", "justify-between");
    expect(pageControls?.textContent).toContain("Page 1 of 4");
    expect(pageControls).toHaveClass("w-full", "justify-between");
    const pagination = pageControls?.querySelector('[data-slot="pagination"]');
    expect(pagination).toBeTruthy();
    expect(pageControls?.firstElementChild).toBe(pagination);
  });

  it("hides pagination chrome for a single page", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(3)}
        enableSearch={false}
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
      />,
    );

    expect(screen.queryByRole("navigation", { name: "pagination" })).toBeNull();
    expect(screen.queryByText(/showing/i)).toBeNull();
  });

  it("preserves whitespace-only search filter behavior", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(3)}
        enableSearch
        searchPlaceholder="Search rows"
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
      />,
    );

    const search = screen.getByPlaceholderText("Search rows");

    fireEvent.change(search, { target: { value: "   " } });

    expect(screen.getByText("Row 1")).toBeTruthy();
    expect(screen.getByText("Row 2")).toBeTruthy();
    expect(screen.getByText("Row 3")).toBeTruthy();
    expect(screen.queryByText("No results.")).toBeNull();
  });
  it("preserves accessible search input behavior", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(3)}
        searchPlaceholder="Search records"
      />,
    );

    const searchInput = screen.getByRole("searchbox", {
      name: "Search table",
    });

    expect(searchInput).toBeTruthy();
    expect(searchInput.getAttribute("placeholder")).toBe("Search records");
    expect(searchInput.getAttribute("aria-hidden")).toBeNull();
  });

  it("renders an opt-in mobile card list while keeping the desktop table shell", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(2)}
        enableSearch={false}
        renderMobileCard={(row) => (
          <article data-testid="mobile-row-card">{row.name}</article>
        )}
      />,
    );

    expect(screen.getAllByTestId("mobile-row-card")).toHaveLength(2);
    expect(
      document.querySelector('[data-slot="data-table-mobile-list"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-slot="surface-data-table-shell"]'),
    ).toHaveClass("hidden", "md:block");
  });

  it("renders compact mobile pagination for card tables", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(30)}
        enableSearch={false}
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
        renderMobileCard={(row) => (
          <article data-testid="mobile-row-card">{row.name}</article>
        )}
      />,
    );

    const mobilePagination = document.querySelector(
      '[data-slot="data-table-mobile-pagination"]',
    );
    const desktopFooter = document.querySelector(
      '[data-slot="data-table-page-controls"]',
    )?.parentElement;
    const mobile = within(mobilePagination as HTMLElement);

    expect(mobilePagination).toHaveClass("md:hidden");
    expect(
      mobile.getByRole("button", { name: "Go to previous page" }),
    ).toBeTruthy();
    expect(mobile.getByText("Page 1")).toBeTruthy();
    expect(mobile.getByRole("button", { name: "Go to next page" })).toBeTruthy();
    expect(mobilePagination?.textContent).not.toContain("Showing");
    expect(desktopFooter).toHaveClass("hidden", "md:flex");
  });

  it("keeps dense page numbers out of mobile card pagination", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(30)}
        enableSearch={false}
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
        renderMobileCard={(row) => (
          <article data-testid="mobile-row-card">{row.name}</article>
        )}
      />,
    );
    const mobilePagination = document.querySelector(
      '[data-slot="data-table-mobile-pagination"]',
    );
    const mobilePageNumberLinks = mobilePagination?.querySelectorAll(
      '[data-slot="pagination-link"]',
    );

    expect(mobilePageNumberLinks).toHaveLength(0);
  });

  it("pages compact mobile card tables with previous and next controls", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(30)}
        enableSearch={false}
        initialPageSize={8}
        renderMobileCard={(row) => (
          <article data-testid="mobile-row-card">{row.name}</article>
        )}
      />,
    );

    const mobilePagination = document.querySelector(
      '[data-slot="data-table-mobile-pagination"]',
    ) as HTMLElement;
    const mobileList = document.querySelector(
      '[data-slot="data-table-mobile-list"]',
    ) as HTMLElement;
    const mobile = within(mobilePagination);
    const mobileRows = within(mobileList);

    expect(mobile.getByText("Page 1")).toBeTruthy();
    expect(
      mobile.getByRole("button", { name: "Go to previous page" }),
    ).toBeDisabled();
    expect(mobileRows.getByText("Row 1")).toBeTruthy();

    fireEvent.click(mobile.getByRole("button", { name: "Go to next page" }));

    expect(mobile.getByText("Page 2")).toBeTruthy();
    expect(mobileRows.getByText("Row 9")).toBeTruthy();
    expect(mobileRows.queryByText("Row 1")).toBeNull();

    fireEvent.click(mobile.getByRole("button", { name: "Go to previous page" }));

    expect(mobile.getByText("Page 1")).toBeTruthy();
    expect(mobileRows.getByText("Row 1")).toBeTruthy();
  });

  it("disables compact mobile next on the last card page", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(9)}
        enableSearch={false}
        initialPageSize={8}
        renderMobileCard={(row) => (
          <article data-testid="mobile-row-card">{row.name}</article>
        )}
      />,
    );

    const mobilePagination = document.querySelector(
      '[data-slot="data-table-mobile-pagination"]',
    ) as HTMLElement;
    const mobile = within(mobilePagination);

    fireEvent.click(mobile.getByRole("button", { name: "Go to next page" }));

    expect(mobile.getByText("Page 2")).toBeTruthy();
    expect(
      mobile.getByRole("button", { name: "Go to next page" }),
    ).toBeDisabled();
  });
});
