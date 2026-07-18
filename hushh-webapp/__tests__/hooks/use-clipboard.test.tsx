import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useClipboard } from "@/hooks/use-clipboard";
import { copyToClipboard } from "@/lib/utils/clipboard";

vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

function Harness() {
  const { copied, copy } = useClipboard();

  return (
    <button type="button" onClick={() => void copy("clipboard text")}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

describe("useClipboard", () => {
  afterEach(() => {
    vi.mocked(copyToClipboard).mockReset();
  });

  it("sets copied state after a successful copy", async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(copyToClipboard).toHaveBeenCalledWith("clipboard text");
    expect((await screen.findByRole("button", { name: "Copied" })).textContent).toBe(
      "Copied"
    );
  });
});
