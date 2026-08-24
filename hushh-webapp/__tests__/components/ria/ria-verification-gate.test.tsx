import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  usePersonaState: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));

import { RiaVerificationGate } from "@/components/ria/ria-page-shell";
import { ROUTES } from "@/lib/navigation/routes";
import { RIA_COPY } from "@/lib/ria/ria-screen-copy";

describe("RiaVerificationGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the lock copy plus a CTA that routes to onboarding when unverified", () => {
    mocks.usePersonaState.mockReturnValue({
      loading: false,
      riaOnboardingStatus: { advisory_status: "draft", verification_status: "draft" },
    });

    render(
      <RiaVerificationGate>
        <div data-testid="gated-content" />
      </RiaVerificationGate>,
    );

    expect(screen.getByText(RIA_COPY.clients.verifyGate.title)).toBeTruthy();
    expect(screen.queryByTestId("gated-content")).toBeNull();

    const cta = screen.getByTestId("ria-clients-verify-gate-cta");
    expect(cta.textContent).toContain(RIA_COPY.clients.verifyGate.cta);

    fireEvent.click(cta);
    expect(mocks.routerPush).toHaveBeenCalledWith(ROUTES.RIA_ONBOARDING);
  });

  it("renders children without the lock when verified", () => {
    mocks.usePersonaState.mockReturnValue({
      loading: false,
      riaOnboardingStatus: { advisory_status: "active", verification_status: "active" },
    });

    render(
      <RiaVerificationGate>
        <div data-testid="gated-content" />
      </RiaVerificationGate>,
    );

    expect(screen.getByTestId("gated-content")).toBeTruthy();
    expect(screen.queryByTestId("ria-clients-verify-gate-cta")).toBeNull();
  });
});
