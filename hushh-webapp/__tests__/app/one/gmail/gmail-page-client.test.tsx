import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

import OneGmailPageClient from "@/app/one/gmail/gmail-page-client";

describe("OneGmailPageClient", () => {
  it("does not mount Gmail in One while the registry is paused", async () => {
    render(<OneGmailPageClient />);

    expect(screen.getByRole("status", { name: "Opening One…" })).toBeTruthy();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one");
    });
  });
});
