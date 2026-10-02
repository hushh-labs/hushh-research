import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { FeedDriveProgressRow } from "@/components/feed/feed-drive-progress-row";

describe("FeedDriveProgressRow", () => {
  it("renders one passive link to the existing request detail", () => {
    const href = "/one/consents?tab=requests&requestId=document_share_request%3A123";
    render(<FeedDriveProgressRow item={{
      id: "document_share_request:123",
      title: "Finding documents",
      description: "Files appear once access is confirmed.",
      href,
      requestedAt: null,
    }} />);

    const link = screen.getByRole("link", { name: /Finding documents/ });
    expect(link).toHaveAttribute("href", href);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("time")).toBeNull();
  });
});
