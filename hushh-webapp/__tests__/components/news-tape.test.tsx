import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NewsTape } from "@/components/kai/home/news-tape";

describe("NewsTape", () => {
  it("covers empty news fallback", () => {
    render(<NewsTape rows={[]} />);

    expect(
      screen.getByText("No recent market headlines are available right now."),
    ).toBeTruthy();
  });
});
