import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

describe("formatCompleteJson markdown cleanup", () => {
  it("removes markdown formatting from string values", () => {
    const output = formatCompleteJson({
      account_metadata: {
        institution_name: "***Schwab***",
      },
    });

    expect(output).toContain("Institution: Schwab");
  });

  it("removes mixed markdown formatting from string values", () => {
    const output = formatCompleteJson({
      account_metadata: {
        institution_name:
          "***bold italic*** and **bold** and *italic* and `code`",
      },
    });

    expect(output).toContain(
      "Institution: bold italic and bold and italic and code",
    );
  });

  it("trims whitespace after markdown cleanup", () => {
    const output = formatCompleteJson({
      account_metadata: {
        institution_name: "  **padded**  ",
      },
    });

    expect(output).toContain("Institution: padded");
  });
});