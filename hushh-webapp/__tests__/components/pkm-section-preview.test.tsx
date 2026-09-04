import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PkmSectionPreview } from "@/components/profile/pkm-section-preview";

describe("PkmSectionPreview", () => {
  it("keeps saved entries scannable and discloses secondary fields only on request", () => {
    render(
      <PkmSectionPreview
        presentation={{
          title: "Preferences",
          stats: [{ label: "Entries", value: "2" }],
          groups: [
            {
              kind: "entities",
              title: "Preferences",
              items: [
                {
                  key: "ice-cream",
                  title: "I love ice cream",
                  subtitle: "preference · active",
                  fields: [{ label: "Favorite brand", value: "Cadbury Dairy Milk" }],
                  sections: [
                    {
                      label: "Observations",
                      items: ["Enjoys dark chocolate"],
                      display: "chips",
                    },
                  ],
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("I love ice cream")).toBeTruthy();
    expect(screen.getByText("preference · active")).toBeTruthy();
    expect(screen.getByText("Enjoys dark chocolate")).toBeTruthy();
    expect(screen.getByText("View details")).toBeTruthy();
    const details = screen.getByText("View details").closest("details");
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("View details"));

    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Favorite brand")).toBeTruthy();
    expect(screen.getByText("Cadbury Dairy Milk")).toBeTruthy();
  });
});
