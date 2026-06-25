import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
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
  it("does not own swipe pagination gestures", () => {
    const dataTableSource = readFileSync(
      join(process.cwd(), "components/app-ui/data-table.tsx"),
      "utf8"
    );
    const marketListSource = readFileSync(
      join(process.cwd(), "components/kai/cards/renaissance-market-list.tsx"),
      "utf8"
    );

    for (const source of [dataTableSource, marketListSource]) {
      expect(source).not.toContain("swipeStartRef");
      expect(source).not.toContain("onTouchStart");
      expect(source).not.toContain("onTouchEnd");
      expect(source).not.toContain("data-no-route-swipe");
      expect(source).not.toContain("Swipe left or right");
    }
  });

  it("keeps Kai route tabs free of global swipe routing", () => {
    const routeTabsSource = readFileSync(
      join(process.cwd(), "components/kai/layout/dashboard-route-tabs.tsx"),
      "utf8"
    );

    expect(routeTabsSource).not.toContain("touchstart");
    expect(routeTabsSource).not.toContain("touchmove");
    expect(routeTabsSource).not.toContain("touchend");
    expect(routeTabsSource).not.toContain("SWIPE_");
    expect(routeTabsSource).not.toContain("data-no-route-swipe");
  });

  it("supports direct page-number navigation", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(30)}
        enableSearch={false}
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
      />
    );

    expect(screen.getByText("Row 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("Row 9")).toBeTruthy();
    expect(screen.queryByText("Row 1")).toBeNull();
  });

  it("hides pagination chrome for a single page", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(3)}
        enableSearch={false}
        initialPageSize={8}
        pageSizeOptions={[8, 16, 24]}
      />
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
      />
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
      />
    );

    const searchInput = screen.getByRole("searchbox", {
      name: "Search table",
    });

    expect(searchInput).toBeTruthy();
    expect(searchInput.getAttribute("placeholder")).toBe("Search records");
    expect(searchInput.getAttribute("aria-hidden")).toBeNull();
  });
});
