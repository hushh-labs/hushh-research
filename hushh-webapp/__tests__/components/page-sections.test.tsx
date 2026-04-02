import { render, screen } from "@testing-library/react";
import { FileSpreadsheet } from "lucide-react";
import { describe, expect, it } from "vitest";

import { PageHeader, SectionHeader } from "@/components/app-ui/page-sections";

describe("PageHeader", () => {
  it("uses the shared mobile stacking and description clamp slots", () => {
    const { container } = render(
      <PageHeader
        eyebrow="Picks"
        title="Stock universe"
        description="A longer supporting line that should clamp on mobile and expand again on larger breakpoints."
        actions={<button type="button">Upload</button>}
        icon={FileSpreadsheet}
      />
    );

    const headerRow = container.firstElementChild?.firstElementChild;
    const row = container.querySelector('[data-slot="page-header-row"]');
    const description = container.querySelector('[data-slot="page-header-description"]');
    const actions = container.querySelector('[data-slot="page-header-actions"]');
    const leading = headerRow?.firstElementChild;

    expect(headerRow?.className).toContain("items-stretch");
    expect(leading?.className).toContain("self-stretch");
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("sm:flex-row");
    expect(description?.className).toContain("line-clamp-2");
    expect(description?.className).toContain("sm:line-clamp-none");
    expect(actions?.className).toContain("sm:shrink-0");
    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
  });
});

describe("SectionHeader", () => {
  it("applies the same mobile clamp and action layout rules", () => {
    const { container } = render(
      <SectionHeader
        eyebrow="My list"
        title="Advisor-managed source"
        description="This supporting text should stay concise on smaller screens."
        actions={<button type="button">Template</button>}
        icon={FileSpreadsheet}
      />
    );

    const headerRow = container.firstElementChild?.firstElementChild;
    const row = container.querySelector('[data-slot="section-header-row"]');
    const description = container.querySelector('[data-slot="section-header-description"]');
    const actions = container.querySelector('[data-slot="section-header-actions"]');
    const leading = headerRow?.firstElementChild;

    expect(headerRow?.className).toContain("items-stretch");
    expect(leading?.className).toContain("self-stretch");
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("sm:flex-row");
    expect(description?.className).toContain("line-clamp-2");
    expect(description?.className).toContain("sm:line-clamp-none");
    expect(actions?.className).toContain("sm:justify-end");
    expect(screen.getByRole("button", { name: "Template" })).toBeTruthy();
  });
});
