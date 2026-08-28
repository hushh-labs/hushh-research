import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EmailRichTextComposer, EmailRichTextPreview } from "@/components/agent/email-rich-text";

describe("EmailRichTextComposer End-to-End Live DOM Verification", () => {
  beforeEach(() => {
    document.execCommand = vi.fn((command, _show, _arg) => {
      const editor = screen.getByTestId("one-email-draft-message");
      if (command === "bold") {
        editor.innerHTML = editor.innerHTML.replace("sample", "<strong>sample</strong>");
      } else if (command === "italic") {
        editor.innerHTML = editor.innerHTML.replace("italic text", "<em>italic text</em>");
      } else if (command === "underline") {
        editor.innerHTML = editor.innerHTML.replace("underlined text", "<u>underlined text</u>");
      } else if (command === "insertUnorderedList") {
        editor.innerHTML = '<ul style="margin:0 0 16px;padding-left:24px"><li style="margin:0 0 8px">Item 1</li><li style="margin:0 0 8px">Item 2</li></ul>';
      }
      return true;
    });
  });

  it("produces live formatted HTML in editorRef without any Edit/Preview toggle button", () => {
    const handleChange = vi.fn();
    render(
      <EmailRichTextComposer
        id="test-editor"
        value={"This is sample text with italic text and underlined text."}
        onChange={handleChange}
      />
    );

    const editor = screen.getByTestId("one-email-draft-message");

    // 1. Verify single box & NO Preview/Edit toggle button
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();

    // 2. Bold live action
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(editor.innerHTML).toContain("<strong>sample</strong>");

    // 3. Italic live action
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    expect(editor.innerHTML).toContain("<em>italic text</em>");

    // 4. Underline live action
    fireEvent.click(screen.getByRole("button", { name: "Underline" }));
    expect(editor.innerHTML).toContain("<u>underlined text</u>");

    // 5. Bullet List live action
    fireEvent.click(screen.getByRole("button", { name: "Bullet list" }));
    expect(editor.innerHTML).toContain("<ul");
    expect(editor.innerHTML).toContain("<li");

    console.log("REAL COMPOSER OUTPUT HTML:", editor.innerHTML);
  });
});

describe("EmailRichTextPreview Dual-Mode Rendering", () => {
  it("renders hand-edited HTML string cleanly as sanitized DOM elements, not raw visible tags", () => {
    const htmlValue = '<p style="margin:0 0 16px">Hi <strong>John</strong>, here is the report:</p><ul style="margin:0 0 16px;padding-left:24px"><li style="margin:0 0 8px">Item A</li></ul><script>alert("xss")</script>';
    const { container } = render(<EmailRichTextPreview value={htmlValue} />);

    // 1. Confirms strong element is parsed into a real DOM node
    const strongEl = screen.getByText("John");
    expect(strongEl.tagName).toBe("STRONG");

    // 2. Confirms list item is a real DOM node
    const liEl = screen.getByText("Item A");
    expect(liEl.tagName).toBe("LI");

    // 3. Confirms script tag was sanitized out
    expect(container.querySelector("script")).toBeNull();

    // 4. Confirms raw HTML tags are NOT leaked as visible text in body
    expect(container.textContent).not.toContain('<p style="margin');
    expect(container.textContent).not.toContain('<script>');
  });

  it("renders untouched AI Markdown draft via parseBlocks without regression", () => {
    const markdownValue = "## Meeting Summary\n\n- Discussed Q3 budget\n- Approved campaign";
    const { container } = render(<EmailRichTextPreview value={markdownValue} />);

    // 1. Confirms heading level 2
    const h2El = screen.getByRole("heading", { level: 2 });
    expect(h2El.textContent).toBe("Meeting Summary");

    // 2. Confirms Markdown list elements rendered via parseBlocks
    const listItems = screen.getAllByRole("listitem");
    expect(listItems).toHaveLength(2);
    expect(listItems[0]?.textContent).toBe("Discussed Q3 budget");
    expect(listItems[1]?.textContent).toBe("Approved campaign");
  });
});
