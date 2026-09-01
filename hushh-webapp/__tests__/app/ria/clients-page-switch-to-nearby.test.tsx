import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ria.clients.switch_to_nearby (#6122) was wired in the contract as
 * execution_target.path: "control" with no handler registered anywhere --
 * the frontend gateway parser's validator dropped the action entirely
 * before a handler could even matter. Now that the validator accepts
 * "control" and a handler is registered here, this pins that invoking it
 * actually flips the Connected/Nearby toggle.
 */

const handlerHarness = vi.hoisted(() => ({
  registered: new Map<string, () => unknown>(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  useLocalOnboardingActionHandler: (actionId: string, handler: () => unknown) => {
    handlerHarness.registered.set(actionId, handler);
  },
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "test-user", getIdToken: vi.fn() } }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({ riaCapability: "active", loading: false }),
}));

vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: () => ({ data: { items: [] }, loading: false, error: null }),
}));

vi.mock("@/components/ria/nearby/nearby-around-you", () => ({
  NearbyAroundYou: () => null,
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaCompatibilityState: ({ children }: { children: React.ReactNode }) => children,
  RiaVerificationGate: ({ children }: { children: React.ReactNode }) => children,
}));

import OneRiaClientsPage from "@/app/ria/clients/page";

describe("ria clients page publishes a working switch_to_nearby handler", () => {
  afterEach(() => {
    handlerHarness.registered.clear();
  });

  it("registers ria.clients.switch_to_nearby and flips the view when invoked", () => {
    render(<OneRiaClientsPage />);

    const handler = handlerHarness.registered.get("ria.clients.switch_to_nearby");
    expect(handler).toBeDefined();

    const result = handler!();
    expect(result).toEqual(
      expect.objectContaining({ status: "succeeded", summary: "Showing nearby clients." }),
    );
  });
});
