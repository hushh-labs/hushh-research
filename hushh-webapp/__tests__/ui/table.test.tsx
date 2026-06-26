import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Table, TableHead, TableHeader } from "@/components/ui/table";

describe("Table", () => {
  it("sets tabIndex on the overflow container for keyboard scrolling", () => {
    const { container } = render(
      <Table>
        <tbody>
          <tr>
            <td>Holding</td>
          </tr>
        </tbody>
      </Table>,
    );

    const tableContainer = container.querySelector(
      '[data-slot="table-container"]',
    );

    expect(tableContainer?.getAttribute("tabindex")).toBe("0");
  });
  it("renders TableHead as a th element with a column scope", () => {
    const { container } = render(
      <Table>
        <thead>
          <tr>
            <TableHead>Symbol</TableHead>
          </tr>
        </thead>
      </Table>,
    );

    const head = container.querySelector('[data-slot="table-head"]');

    expect(head?.tagName).toBe("TH");
    expect(head?.getAttribute("scope")).toBe("col");
  });

  it("renders TableHeader with the table-header data-slot contract", () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <tr>
            <th>Symbol</th>
          </tr>
        </TableHeader>
      </Table>,
    );

    const header = container.querySelector('[data-slot="table-header"]');

    expect(header).toBeTruthy();
    expect(header?.tagName).toBe("THEAD");
  });

  it("renders the table container with role='region' and an aria-label", () => {
    const { container } = render(
      <Table>
        <tbody>
          <tr>
            <td>Holding</td>
          </tr>
        </tbody>
      </Table>,
    );

    const tableContainer = container.querySelector(
      '[data-slot="table-container"]',
    );

    expect(tableContainer?.getAttribute("role")).toBe("region");
    expect(tableContainer?.getAttribute("aria-label")).toBe(
      "Scrollable table",
    );
  });

});
