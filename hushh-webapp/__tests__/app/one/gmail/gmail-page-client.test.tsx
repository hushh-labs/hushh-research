import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: () => <div>Gmail receipts mounted</div>,
}));

import OneGmailPageClient from "@/app/one/gmail/gmail-page-client";

describe("OneGmailPageClient", () => {
  it("mounts Gmail when the shared registry enables the capability", () => {
    render(<OneGmailPageClient />);

    expect(screen.getByText("Gmail receipts mounted")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
