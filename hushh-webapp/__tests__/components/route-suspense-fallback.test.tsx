import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

describe("RouteSuspenseFallback", () => {
  it("renders loading status semantics", () => {
    render(<RouteSuspenseFallback label="Loading dashboard" />);

    const [fallbackStatus, loaderStatus] = screen.getAllByRole("status");

    expect(fallbackStatus.getAttribute("aria-live")).toBe("polite");
    expect(loaderStatus.getAttribute("aria-live")).toBe("polite");
    expect(loaderStatus.getAttribute("aria-busy")).toBe("true");
    expect(loaderStatus.getAttribute("aria-atomic")).toBe("true");
    expect(loaderStatus.textContent).toContain("Loading dashboard");
  });
});
