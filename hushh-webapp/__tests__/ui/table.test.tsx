import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Table } from "@/components/ui/table";

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
});
