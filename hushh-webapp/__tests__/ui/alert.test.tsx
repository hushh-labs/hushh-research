import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

describe("Alert", () => {
  it("renders root with data-slot='alert'", () => {
    const { container } = render(<Alert />);

    expect(container.querySelector('[data-slot="alert"]')).toBeTruthy();
  });

  it("renders root with role='alert'", () => {
    const { container } = render(<Alert />);

    const alert = container.querySelector('[data-slot="alert"]');

    expect(alert?.getAttribute("role")).toBe("alert");
  });

  it("renders AlertTitle with data-slot='alert-title'", () => {
    const { container } = render(
      <Alert>
        <AlertTitle>Title</AlertTitle>
      </Alert>,
    );

    expect(container.querySelector('[data-slot="alert-title"]')).toBeTruthy();
  });

  it("renders AlertDescription with data-slot='alert-description'", () => {
    const { container } = render(
      <Alert>
        <AlertDescription>Description</AlertDescription>
      </Alert>,
    );

    expect(
      container.querySelector('[data-slot="alert-description"]'),
    ).toBeTruthy();
  });

  it("preserves alert data-slot contracts in a composed alert", () => {
    const { container } = render(
      <Alert>
        <AlertTitle>Account notice</AlertTitle>
        <AlertDescription>Review your account details.</AlertDescription>
      </Alert>,
    );

    const alert = container.querySelector('[data-slot="alert"]');
    const slots = Array.from(container.querySelectorAll("[data-slot]")).map(
      (element) => element.getAttribute("data-slot"),
    );

    expect(alert?.getAttribute("role")).toBe("alert");
    expect(slots).toEqual(["alert", "alert-title", "alert-description"]);
  });
});
