import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/app-ui/data-table";

type TestRow = {
  id: number;
  name: string;
};

type LogRow = {
  source: string;
  timestamp: string;
  eventType: string;
  payload: string;
};

const columns: ColumnDef<TestRow>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => row.original.name,
  },
];

const logColumns: ColumnDef<LogRow>[] = [
  {
    accessorKey: "source",
    header: "Source",
    cell: ({ row }) => row.original.source,
  },
  {
    accessorKey: "timestamp",
    header: "Timestamp",
    cell: ({ row }) => row.original.timestamp,
  },
  {
    accessorKey: "eventType",
    header: "Event Type",
    cell: ({ row }) => row.original.eventType,
  },
  {
    accessorKey: "payload",
    header: "Action Payload",
    cell: ({ row }) => row.original.payload,
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

  it("preserves accessible search input behavior", () => {
    render(
      <DataTable
        columns={columns}
        data={makeRows(3)}
        searchPlaceholder="Search records"
      />
    );

    const searchInput = screen.getByRole("textbox", { name: "Search table" });

    expect(searchInput).toBeTruthy();
    expect(searchInput.getAttribute("placeholder")).toBe("Search records");
    expect(searchInput.getAttribute("aria-hidden")).toBeNull();
  });

  it("renders multi-source log rows in a bounded responsive table shell", () => {
    const logRows: LogRow[] = [
      {
        source: "PKM_SYNC_SERVICE",
        timestamp: "11:45",
        eventType: "TOKEN_REFRESH",
        payload: "SUCCESS",
      },
      {
        source: "CON_PROTOCOL_API",
        timestamp: "11:46",
        eventType: "CONSENT_UPDATE",
        payload: "REVOKED",
      },
      {
        source: "WEB_APP_SANDBOX",
        timestamp: "11:47",
        eventType: "LAYOUT_MOUNT",
        payload: "STABLE",
      },
    ];

    render(
      <DataTable
        columns={logColumns}
        data={logRows}
        enableSearch={false}
        initialPageSize={8}
        tableClassName="min-w-[680px]"
      />
    );

    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Timestamp" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Event Type" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Action Payload" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(logRows.length + 1);

    const tableShell = document.querySelector('[data-slot="surface-data-table-shell"]');
    expect(tableShell?.className).toContain("overflow-x-auto");
    expect(tableShell?.className).toContain("w-full");

    for (const row of logRows) {
      expect(screen.getByText(row.source)).toBeTruthy();
      expect(screen.getByText(row.timestamp)).toBeTruthy();
      expect(screen.getByText(row.eventType)).toBeTruthy();
      expect(screen.getByText(row.payload)).toBeTruthy();
    }
  });
});
