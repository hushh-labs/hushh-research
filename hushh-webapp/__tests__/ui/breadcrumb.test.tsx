import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

describe("Breadcrumb", () => {
  it("renders a separator between breadcrumb items", () => {
    const { container } = render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>Home</BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Settings</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );

    const list = screen.getByRole("list");
    const separator = container.querySelector('[data-slot="breadcrumb-separator"]');

    expect(separator).toBeTruthy();
    expect(list.children[0]?.textContent).toBe("Home");
    expect(list.children[1]).toBe(separator);
    expect(list.children[2]?.textContent).toBe("Settings");
  });

  it('renders BreadcrumbList with data-slot="breadcrumb-list"', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>Home</BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );

    const list = screen.getByRole("list");

    expect(list.getAttribute("data-slot")).toBe("breadcrumb-list");
  });

});
