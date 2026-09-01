import { describe, expect, it } from "vitest";

import { resolveSiriOneActionHandoffState } from "@/lib/agent/siri-one-action-handoff-policy";

const readyInput = {
  now: 1_000,
  expiresAt: 301_000,
  visible: true,
  authLoading: false,
  signedIn: true,
  pathname: "/one",
  loginPath: "/login",
  runtimeReady: true,
  tier: "signed_unlocked" as const,
  requiresVault: true,
  executorReady: true,
};

describe("Siri One action handoff policy", () => {
  it("waits through foreground, auth, route, runtime, vault, and executor restoration", () => {
    expect(
      resolveSiriOneActionHandoffState({ ...readyInput, visible: false }),
    ).toBe("waiting_for_foreground");
    expect(
      resolveSiriOneActionHandoffState({ ...readyInput, authLoading: true }),
    ).toBe("waiting_for_auth_restoration");
    expect(
      resolveSiriOneActionHandoffState({ ...readyInput, signedIn: false }),
    ).toBe("waiting_for_auth");
    expect(
      resolveSiriOneActionHandoffState({ ...readyInput, pathname: "/login" }),
    ).toBe("waiting_for_route");
    expect(
      resolveSiriOneActionHandoffState({ ...readyInput, runtimeReady: false }),
    ).toBe("waiting_for_runtime");
    expect(
      resolveSiriOneActionHandoffState({
        ...readyInput,
        tier: "signed_locked",
      }),
    ).toBe("waiting_for_vault");
    expect(
      resolveSiriOneActionHandoffState({
        ...readyInput,
        executorReady: false,
      }),
    ).toBe("waiting_for_executor");
  });

  it("allows UI-only navigation in the signed-locked tier", () => {
    expect(
      resolveSiriOneActionHandoffState({
        ...readyInput,
        tier: "signed_locked",
        requiresVault: false,
      }),
    ).toBe("dispatch");
  });

  it("dispatches only when every lifecycle gate is ready", () => {
    expect(resolveSiriOneActionHandoffState(readyInput)).toBe("dispatch");
  });

  it("expires before attempting any restoration", () => {
    expect(
      resolveSiriOneActionHandoffState({
        ...readyInput,
        expiresAt: readyInput.now,
        visible: false,
      }),
    ).toBe("expired");
  });
});
