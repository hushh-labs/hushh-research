import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentActionRecoveryCard } from "@/components/agent/agent-action-recovery-card";
import type { AgentActionRecoveryPlan } from "@/lib/agent/agent-action-recovery-plan";
import { ROUTES } from "@/lib/navigation/routes";

const plan: AgentActionRecoveryPlan = {
  id: "analysis.start.open_workspace_then_execute",
  originalActionId: "analysis.start",
  title: "Start NVDA analysis safely",
  summary:
    "Open the Analysis workspace, wait until it is ready, request fresh consent, start the analysis, and verify the resulting effect.",
  sourceReason: "unavailable",
  requiresFreshConsent: true,
  mayAutoExecute: false,
  policyDecision: {
    disposition: "propose",
    reason: "safe_recovery_available",
    mayAutoRetry: false,
    requiresFreshConsent: true,
  },
  steps: [
    {
      id: "open_analysis_workspace",
      kind: "navigate",
      label: "Open the Analysis workspace",
      target: ROUTES.KAI_ANALYSIS,
    },
    {
      id: "wait_for_analysis_workspace",
      kind: "wait_for_runtime",
      label: "Wait until the Analysis workspace is ready",
      condition: "analysis_workspace_ready",
    },
    {
      id: "confirm_analysis_start",
      kind: "request_consent",
      label: "Confirm starting an analysis for NVDA",
      actionId: "analysis.start",
    },
    {
      id: "execute_analysis_start",
      kind: "execute_action",
      label: "Start the NVDA analysis",
      actionId: "analysis.start",
      slots: {
        symbol: "NVDA",
      },
    },
    {
      id: "verify_analysis_started",
      kind: "verify_effect",
      label: "Verify that the analysis started",
      actionId: "analysis.start",
      acceptedEffectStates: ["started", "completed"],
    },
  ],
};

describe("AgentActionRecoveryCard", () => {
  it("renders the user-facing recovery proposal", () => {
    render(
      <AgentActionRecoveryCard
        plan={plan}
        onContinue={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Start NVDA analysis safely",
      }),
    ).toBeTruthy();

    expect(screen.getByText("Fresh approval required")).toBeTruthy();

    expect(
      screen.getByText("Open the Analysis workspace"),
    ).toBeTruthy();

    expect(
      screen.getByText("Wait until the Analysis workspace is ready"),
    ).toBeTruthy();

    expect(
      screen.getByText("Confirm starting an analysis for NVDA"),
    ).toBeTruthy();

    expect(screen.getByText("Start the NVDA analysis")).toBeTruthy();

    expect(
      screen.getByText("Verify that the analysis started"),
    ).toBeTruthy();
  });

  it("does not expose internal action ids or runtime reasons", () => {
    render(
      <AgentActionRecoveryCard
        plan={plan}
        onContinue={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.queryByText("analysis.start")).toBeNull();
    expect(screen.queryByText("unavailable")).toBeNull();
    expect(screen.queryByText("safe_recovery_available")).toBeNull();
  });

  it("calls the continue handler after user approval", () => {
    const onContinue = vi.fn();

    render(
      <AgentActionRecoveryCard
        plan={plan}
        onContinue={onContinue}
        onCancel={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Review and continue",
      }),
    );

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("calls the cancel handler", () => {
    const onCancel = vi.fn();

    render(
      <AgentActionRecoveryCard
        plan={plan}
        onContinue={() => undefined}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables both decisions while continuing", () => {
    render(
      <AgentActionRecoveryCard
        plan={plan}
        onContinue={() => undefined}
        onCancel={() => undefined}
        isContinuing
      />,
    );

    const continueButton = screen.getByRole("button", {
      name: "Review and continue",
    }) as HTMLButtonElement;

    const cancelButton = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;

    expect(continueButton.disabled).toBe(true);
    expect(cancelButton.disabled).toBe(true);
  });
});
