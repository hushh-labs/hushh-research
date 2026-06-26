import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PkmJsonTree } from "@/components/profile/pkm-tree-view";

describe("PkmJsonTree", () => {
  it("renders expandable tree item trigger with button type", () => {
    const { container } = render(
      <PkmJsonTree
        rootLabel="Profile memory"
        value={{ identity: { name: "Avery" } }}
      />
    );

    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');

    expect(trigger).toBeTruthy();
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.getAttribute("type")).toBe("button");
  });
});
