import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentMarkdown } from "@/components/agent/agent-markdown";

describe("AgentMarkdown", () => {
  it("formats streamed answer headings and emphasis instead of showing Markdown syntax", () => {
    render(<AgentMarkdown text={"## Connected apps\n\n**Gmail** is connected."} />);

    expect(screen.getByRole("heading", { name: "Connected apps" })).toBeInTheDocument();
    expect(screen.getByText("Gmail").tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*Gmail\*\*/)).not.toBeInTheDocument();
  });
});
