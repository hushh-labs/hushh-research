import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: () => <div>Gmail workspace</div>,
}));

import OneGmailPageClient from "@/app/one/gmail/gmail-page-client";

describe("OneGmailPageClient", () => {
  it("mounts Gmail in One when the shared registry enables the agent", async () => {
    render(<OneGmailPageClient />);

    expect(screen.getByText("Gmail workspace")).toBeTruthy();
    await waitFor(() => expect(replace).not.toHaveBeenCalled());
  });
});
