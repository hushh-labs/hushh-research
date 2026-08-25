import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  EmailRichTextPreview,
  normalizeRichEmailText,
  richEmailHtmlFromMarkdown,
} from "@/components/agent/email-rich-text";

describe("Email rich text", () => {
  it("keeps the in-app preview and Gmail HTML alternative aligned", () => {
    const body = "## Update\\n\\n**Important** details are *ready*.\\n\\n> Please review before Friday.\\n\\n:::center\\n[Open the report](https://example.com/report)\\n:::";

    render(<EmailRichTextPreview value={body} />);

    expect(screen.getByRole("heading", { name: "Update" })).toBeVisible();
    expect(screen.getByText("Important").tagName).toBe("STRONG");
    expect(screen.getByText("Please review before Friday.").closest("blockquote")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the report" })).toHaveAttribute(
      "href",
      "https://example.com/report",
    );
    expect(richEmailHtmlFromMarkdown(body)).toBe(
      '<h2>Update</h2><p><strong>Important</strong> details are <em>ready</em>.</p><blockquote>Please review before Friday.</blockquote><p style="text-align:center"><a href="https://example.com/report">Open the report</a></p>',
    );
  });

  it("normalizes literal escaped newlines from a drafting model", () => {
    expect(normalizeRichEmailText("Hi,\\n\\nThanks")).toBe("Hi,\n\nThanks");
  });
});
