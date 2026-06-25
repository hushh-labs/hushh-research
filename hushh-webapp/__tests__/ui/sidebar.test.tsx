import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidebarProvider, SidebarRail } from "@/components/ui/sidebar";

describe("Sidebar", () => {
  it("renders rail with data-slot='sidebar-rail'", () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarRail />
      </SidebarProvider>,
    );

    expect(
      container.querySelector('[data-slot="sidebar-rail"]'),
    ).toBeTruthy();
  });
});
