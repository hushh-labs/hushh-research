import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

describe("Alert", () => {
  it("renders alert data-slot contracts", () => {
    render(
      <Alert>
        <AlertTitle>Account notice</AlertTitle>
        <AlertDescription>Review your account details.</AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole("alert");

    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(
      screen.getByText("Account notice").getAttribute("data-slot"),
    ).toBe("alert-title");
    expect(
      screen.getByText("Review your account details.").getAttribute(
        "data-slot",
      ),
    ).toBe("alert-description");
  });
});
