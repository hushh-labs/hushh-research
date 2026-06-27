import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

describe("Card", () => {
  it("renders all data-slot contracts", () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
          <CardAction>Action</CardAction>
        </CardHeader>

        <CardContent>Content</CardContent>

        <CardFooter>Footer</CardFooter>
      </Card>,
    );

    expect(container.querySelector('[data-slot="card"]')).toBeTruthy();

    expect(
      container.querySelector('[data-slot="card-header"]'),
    ).toBeTruthy();

    expect(
      container.querySelector('[data-slot="card-title"]'),
    ).toBeTruthy();

    expect(
      container.querySelector('[data-slot="card-description"]'),
    ).toBeTruthy();

    expect(
      container.querySelector('[data-slot="card-action"]'),
    ).toBeTruthy();

    expect(
      container.querySelector('[data-slot="card-content"]'),
    ).toBeTruthy();

    expect(
      container.querySelector('[data-slot="card-footer"]'),
    ).toBeTruthy();
  });

  it("renders CardTitle as an h3 heading element", () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
      </Card>,
    );

    const title = container.querySelector('[data-slot="card-title"]');

    expect(title?.tagName).toBe("H3");
  });

  it("renders CardFooter with the card-footer data-slot contract", () => {
    const { container } = render(<CardFooter>Footer</CardFooter>);

    expect(container.firstElementChild?.getAttribute("data-slot")).toBe("card-footer");
  });

  it("renders CardDescription as a div element", () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardDescription>Description</CardDescription>
        </CardHeader>
      </Card>,
    );

    const description = container.querySelector(
      '[data-slot="card-description"]',
    );

    expect(description?.tagName).toBe("DIV");
  });

});
