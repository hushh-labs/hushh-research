import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthLegalFooter } from "@/components/onboarding/auth-legal-footer";

describe("AuthLegalFooter", () => {
  it("keeps authentication legal disclosures visible and routes policy actions", () => {
    const onOpenLegalDoc = vi.fn();

    render(<AuthLegalFooter onOpenLegalDoc={onOpenLegalDoc} />);

    const footer = screen.getByRole("contentinfo", {
      name: "Authentication legal disclosures",
    });

    expect(footer).toBeTruthy();
    expect(screen.getByText(/By continuing, you agree to Kai's/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Privacy Policy" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Terms" }));
    expect(onOpenLegalDoc).toHaveBeenCalledWith("terms");

    fireEvent.click(screen.getByRole("button", { name: "Privacy Policy" }));
    expect(onOpenLegalDoc).toHaveBeenCalledWith("privacy");
  });
});
