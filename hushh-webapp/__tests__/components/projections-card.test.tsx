import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectionsCard } from "@/components/kai/cards/projections-card";

describe("ProjectionsCard", () => {
  it("renders unavailable projection fallback", () => {
    const { container } = render(<ProjectionsCard projections={{}} />);

    expect(container.firstChild).toBeNull();
  });
});
