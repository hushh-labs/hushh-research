import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  RiaPageShell,
  RiaCompatibilityState,
  MetricTile,
  RiaStatusPanel,
  isRiaVerified,
  RiaVerificationGate,
} from "@/components/ria/ria-page-shell";

const mockUsePersonaState = vi.fn();
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => mockUsePersonaState(),
}));

describe("RiaCompatibilityState", () => {
  it("covers compatibility warning copy", () => {
    render(
      <RiaCompatibilityState
        title="Client workspace is unavailable"
        description="IAM schema is still warming up."
      />
    );

    expect(screen.getByText("Compatibility Mode")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Client workspace is unavailable" })).toBeTruthy();
    expect(screen.getByText("IAM schema is still warming up.")).toBeTruthy();
    expect(
      screen.getByText(
        /This surface is running in degraded compatibility mode until the full IAM contract is available in the active environment\./
      )
    ).toBeTruthy();
  });
});

describe("isRiaVerified", () => {
  it("returns true for verified statuses case-insensitively", () => {
    expect(isRiaVerified("active")).toBe(true);
    expect(isRiaVerified("Verified")).toBe(true);
    expect(isRiaVerified("FINRA_VERIFIED")).toBe(true);
  });

  it("returns false for other statuses or null", () => {
    expect(isRiaVerified("pending")).toBe(false);
    expect(isRiaVerified(null)).toBe(false);
    expect(isRiaVerified(undefined)).toBe(false);
  });
});

describe("MetricTile", () => {
  it("renders metric label, value and helper text", () => {
    render(<MetricTile label="Users" value="123" helper="Registered users" />);
    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByText("123")).toBeTruthy();
    expect(screen.getByText("Registered users")).toBeTruthy();
  });
});

describe("RiaStatusPanel", () => {
  it("renders status panel title, description, and list items with tones", () => {
    const items = [
      { label: "Pending", value: "5", tone: "warning" as const },
      { label: "Active", value: "20", tone: "success" as const },
    ];
    render(
      <RiaStatusPanel
        title="Verification Status"
        description="Verify status of the advisors"
        items={items}
        eyebrow="Verification Summary"
      />
    );

    expect(screen.getByText("Verification Summary")).toBeTruthy();
    expect(screen.getByText("Verification Status")).toBeTruthy();
    expect(screen.getByText("Verify status of the advisors")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
  });
});

describe("RiaPageShell", () => {
  it("renders shell elements and children content", () => {
    render(
      <RiaPageShell title="Advisor Center" eyebrow="RIA portal" description="Portal description">
        <div>Child Content</div>
      </RiaPageShell>
    );

    expect(screen.getByText("RIA portal")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Advisor Center" })).toBeTruthy();
    expect(screen.getByText("Portal description")).toBeTruthy();
    expect(screen.getByText("Child Content")).toBeTruthy();
  });
});

describe("RiaVerificationGate", () => {
  it("returns null while loading persona state", () => {
    mockUsePersonaState.mockReturnValue({
      loading: true,
      riaOnboardingStatus: null,
    });
    const { container } = render(
      <RiaVerificationGate>
        <div>Content</div>
      </RiaVerificationGate>
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders warning message when advisor is unverified", () => {
    mockUsePersonaState.mockReturnValue({
      loading: false,
      riaOnboardingStatus: { verification_status: "pending" },
    });
    render(
      <RiaVerificationGate>
        <div>Protected Content</div>
      </RiaVerificationGate>
    );

    expect(screen.queryByText("Protected Content")).toBeNull();
    expect(screen.getByText("Complete advisor verification first")).toBeTruthy();
    expect(
      screen.getByText(
        "Investor data, client workspaces, and consent requests are locked until regulatory verification is complete."
      )
    ).toBeTruthy();
  });

  it("renders children when advisor is verified", () => {
    mockUsePersonaState.mockReturnValue({
      loading: false,
      riaOnboardingStatus: { verification_status: "active" },
    });
    render(
      <RiaVerificationGate>
        <div>Protected Content</div>
      </RiaVerificationGate>
    );

    expect(screen.getByText("Protected Content")).toBeTruthy();
  });
});
