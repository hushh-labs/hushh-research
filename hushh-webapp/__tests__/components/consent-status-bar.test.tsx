import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("@/lib/morphy-ux/ui", () => ({
  Icon: () => null,
}));

import { ConsentStatusBar } from "@/components/consent/status-bar";

describe("ConsentStatusBar", () => {
  it("renders nothing when no session token is present", () => {
    const { container } = render(<ConsentStatusBar />);
    expect(container.firstChild).toBeNull();
  });
});
