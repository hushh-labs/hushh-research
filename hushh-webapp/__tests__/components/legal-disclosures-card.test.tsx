import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LegalDisclosuresCard } from "@/components/kai/cards/legal-disclosures-card";

describe("LegalDisclosuresCard", () => {
  it("covers disclosure list semantics", () => {
    render(
      <LegalDisclosuresCard
        disclosures={[
          "General account disclosure text.",
          "Privacy and personal information notice.",
          "USA PATRIOT Act requires identity verification.",
          "SIPC protection disclosure.",
        ]}
      />,
    );

    const disclosureRows = screen
      .getAllByRole("button")
      .filter((button) => !button.textContent?.includes("Show"));
    const showMoreButton = screen.getByRole("button", {
      name: /show 1 more/i,
    });

    expect(disclosureRows).toHaveLength(3);
    expect(disclosureRows[0].textContent).toContain("USA PATRIOT Act");
    expect(disclosureRows[1].textContent).toContain("SIPC Protection");
    expect(disclosureRows[2].textContent).toContain("Privacy Notice");
    expect(showMoreButton).toBeTruthy();
  });
});
