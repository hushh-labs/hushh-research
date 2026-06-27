import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RecoveryKeyDialog } from "@/components/vault/recovery-key-dialog";

vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@/lib/utils/native-download", () => ({
  downloadTextFile: vi.fn(),
}));

describe("RecoveryKeyDialog", () => {
  it("renders the copy action as an explicit button", () => {
    render(
      <RecoveryKeyDialog
        open
        recoveryKey="recovery-key-123"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /copy key/i }).getAttribute("type")).toBe(
      "button",
    );
  });
});
