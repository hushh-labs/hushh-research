import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Briefcase } from "lucide-react";

vi.mock("@/lib/morphy-ux/morphy", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, type, disabled }: { children: React.ReactNode; type?: string; disabled?: boolean }) => (
    <button type={(type as "button" | "submit" | "reset") ?? "button"} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { ComingSoonCard } from "@/components/dashboard/coming-soon-card";

describe("ComingSoonCard", () => {
  it("renders notify button with explicit type=button to prevent accidental form submission", () => {
    render(
      <ComingSoonCard
        title="Test Feature"
        description="A feature coming soon."
        icon={Briefcase}
      />
    );
    const button = screen.getByRole("button", { name: /notify me when ready/i });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
