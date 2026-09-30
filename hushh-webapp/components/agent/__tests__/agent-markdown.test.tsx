import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { AgentMarkdown } from "@/components/agent/agent-markdown";

describe("AgentMarkdown", () => {
  it("formats streamed answer headings and emphasis instead of showing Markdown syntax", () => {
    render(<AgentMarkdown text={"## Connected apps\n\n**Gmail** is connected."} />);

    expect(screen.getByRole("heading", { name: "Connected apps" })).toBeInTheDocument();
    expect(screen.getByText("Gmail").tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*Gmail\*\*/)).not.toBeInTheDocument();
  });

  it("keeps a wide answer table readable in its own horizontal scroller", () => {
    render(<AgentMarkdown text={"| Holding | Quantity | Price | Value |\n| --- | ---: | ---: | ---: |\n| Example | 120 | $32 | $3,840 |"} />);
    const scroller = screen.getByRole("region", { name: "Table" });
    expect(scroller).toHaveClass("overflow-x-auto", "max-w-full");
    expect(scroller.querySelector("table")).toHaveClass("min-w-max");
  });

  it("gives each answer its own source ids, so a citation never jumps to another answer's sources", () => {
    const answer = "Nonstop fares start at $842[^1].\n\n[^1]: [TAP fares](https://www.flytap.com/)";
    render(
      <>
        <AgentMarkdown text={answer} />
        <AgentMarkdown text={answer} />
      </>,
    );
    const citations = screen.getAllByRole("link", { name: "Source 1" });
    expect(citations).toHaveLength(2);
    const [first, second] = citations.map((link) => link.getAttribute("href")!);
    expect(first).not.toBe(second);
    for (const href of [first, second]) {
      expect(document.querySelectorAll(`[id="${href.slice(1)}"]`)).toHaveLength(1);
    }
    expect(screen.getAllByRole("list", { name: "Sources" })).toHaveLength(2);
    // The "back to reference" arrows are dropped; the numbered citation already links here.
    expect(document.querySelector("[data-footnote-backref]")).toBeNull();
  });

  it("copies a code block's exact text and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AgentMarkdown text={"```bash\ncurl -sS https://example.com/a?b=1 -o out.csv\n```"} />);
    expect(screen.getByRole("region", { name: "Bash code" })).toHaveAttribute("tabindex", "0");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(writeText).toHaveBeenCalledWith("curl -sS https://example.com/a?b=1 -o out.csv");
    expect(screen.getByRole("button", { name: "Code copied" })).toBeInTheDocument();
  });
});
