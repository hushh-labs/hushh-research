import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

describe("formatCompleteJson", () => {
  it("characterizes nested arrays", () => {
    const output = formatCompleteJson({
      extracted_groups: [
        ["cash", "equities"],
        ["bonds"],
      ],
      portfolio_summary: {
        review_notes: ["needs review", "ready"],
      },
    });

    expect(output).toContain("--- Extracted Groups (2 items) ---");
    expect(output).toContain("cash,equities");
    expect(output).toContain("bonds");
    expect(output).toContain("Review Notes: 2 item(s)");
  });
});
