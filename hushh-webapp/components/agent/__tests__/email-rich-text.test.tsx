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
      '<h2 style="margin:0 0 14px;font-size:20px;line-height:1.3">Update</h2><p style="margin:0 0 16px;line-height:1.6"><strong>Important</strong> details are <em>ready</em>.</p><blockquote style="margin:0 0 16px;padding-left:16px;color:#5f6368">Please review before Friday.</blockquote><p style="margin:0 0 16px;line-height:1.6;text-align:center"><a href="https://example.com/report">Open the report</a></p>',
    );
  });

  it("uses real list markup and spacing for Gmail delivery", () => {
    expect(richEmailHtmlFromMarkdown("Hi,\n\n- **First** benefit\n- Second benefit\n\nBest,\nHushh")).toContain(
      '<ul style="margin:0 0 16px;padding-left:24px"><li style="margin:0 0 8px"><strong>First</strong> benefit</li><li style="margin:0 0 8px">Second benefit</li></ul>',
    );
  });

  it("normalizes literal escaped newlines from a drafting model", () => {
    expect(normalizeRichEmailText("Hi,\\n\\nThanks")).toBe("Hi,\n\nThanks");
  });
});
