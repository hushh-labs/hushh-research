import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsentDialog } from "@/components/consent/consent-dialog";

describe("ConsentDialog", () => {
  it("sets the busy aria contract while loading", () => {
    render(
      <ConsentDialog
        open
        loading
        request={{
          agentId: "agent-1",
          agentName: "Shopping Agent",
          scope: "attr.shopping.receipts.*",
          scopeDescription: "Read shopping receipt history",
        }}
        onGrant={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Shopping Agent" });

    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
