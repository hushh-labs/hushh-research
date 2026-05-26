import { fireEvent, render, screen } from "@testing-library/react";
import { FileSpreadsheet } from "lucide-react";
import { describe, expect, it } from "vitest";

import { PageHeader, SectionHeader, HeaderBadge } from "@/components/app-ui/page-sections";

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
    expect(actions?.className).toContain("sm:shrink-0");
    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
  });

  it("applies sticky classes when isSticky is true", () => {
    const { container } = render(<PageHeader title="Sticky Header" isSticky />);
    const header = container.querySelector("header");
    expect(header?.className).toContain("sticky");
    expect(header?.className).toContain("top-0");
  });

  it("renders a skeleton loader when loading is true", () => {
    const { container, getByTestId } = render(<PageHeader title="Loading Header" loading />);
    expect(container.querySelector("header")).toBeNull();
    expect(getByTestId("page-header-skeleton")).toBeTruthy();
    expect(screen.queryByText("Loading Header")).toBeNull();
  });

  it("toggles the description expansion when Chevron toggle buttons are clicked", () => {
    render(
      <PageHeader
        title="Collapsible Header"
        description="This description is collapsible."
      />
    );

    const descText = screen.getByText("This description is collapsible.");
    expect(descText.className).toContain("line-clamp-2");
    
    const toggleButton = screen.getByRole("button", { name: /read more/i });
    expect(toggleButton).toBeTruthy();

    fireEvent.click(toggleButton);

    expect(descText.className).not.toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: /show less/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /show less/i }));
    expect(descText.className).toContain("line-clamp-2");
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
    expect(actions?.className).toContain("sm:justify-end");
    expect(screen.getByRole("button", { name: "Template" })).toBeTruthy();
  });

  it("preserves section action rendering when actions are provided", () => {
    render(
      <SectionHeader
        title="Advisor tools"
        description="Workspace actions"
        actions={<button type="button">Create</button>}
        icon={FileSpreadsheet}
      />
    );

    expect(screen.getByText("Advisor tools")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });
});

describe("HeaderBadge", () => {
  it("renders with correct children and default color classes", () => {
    render(<HeaderBadge>New</HeaderBadge>);
    const badge = screen.getByText("New");
    expect(badge.className).toContain("bg-muted");
  });

  it("renders with accent color class when specified", () => {
    render(<HeaderBadge color="kai">Interactive</HeaderBadge>);
    const badge = screen.getByText("Interactive");
    expect(badge.className).toContain("bg-violet-100");
  });
});
