import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentRuntimeStateProvider,
  useAgentRuntimeState,
  type AgentRuntimeState,
} from "@/lib/agent/agent-runtime-context";

let mockPathname = "/profile";
const cacheMocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  listeners: new Set<(event: { type: "set"; key: string }) => void>(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user_1" },
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: false,
    vaultOwnerToken: null,
    tokenExpiresAt: null,
  }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({
    activePersona: "investor",
    primaryNavPersona: "investor",
    personaTransitionTarget: null,
    riaSetupAvailable: false,
    riaSwitchAvailable: false,
  }),
}));

vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: (selector: (state: unknown) => unknown) =>
    selector({
      analysisParams: null,
      busyOperations: {},
    }),
}));

vi.mock("@/lib/services/cache-service", () => ({
  CACHE_KEYS: {
    PORTFOLIO_DATA: (uid: string) => `portfolio:${uid}`,
    DOMAIN_DATA: (uid: string, domain: string) => `domain:${uid}:${domain}`,
    PRE_VAULT_BOOTSTRAP: (uid: string) => `pre-vault:${uid}`,
  },
  CacheService: {
    getInstance: () => ({
      get: (key: string) => cacheMocks.values.get(key) ?? null,
      subscribe: (listener: (event: { type: "set"; key: string }) => void) => {
        cacheMocks.listeners.add(listener);
        return () => cacheMocks.listeners.delete(listener);
      },
    }),
  },
}));

function Probe({ onValue }: { onValue: (value: AgentRuntimeState) => void }) {
  const runtime = useAgentRuntimeState();
  useEffect(() => {
    onValue(runtime);
  }, [onValue, runtime]);
  return (
    <div data-testid="screen">
      {runtime.screen}:{runtime.appRuntimeState.route.subview ?? ""}
    </div>
  );
}

describe("AgentRuntimeStateProvider", () => {
  beforeEach(() => {
    mockPathname = "/profile";
    window.history.replaceState({}, "", "/profile");
    cacheMocks.values.clear();
    cacheMocks.listeners.clear();
  });

  it("updates shared runtime context for query-only route changes", async () => {
    const seen: AgentRuntimeState[] = [];
    render(
      <AgentRuntimeStateProvider>
        <Probe onValue={(value) => seen.push(value)} />
      </AgentRuntimeStateProvider>
    );

    await waitFor(() => {
      expect(seen.at(-1)?.screen).toBe("profile_account");
    });

    act(() => {
      window.history.pushState({}, "", "/profile?panel=gmail&tab=account");
    });

    await waitFor(() => {
      const latest = seen.at(-1);
      expect(latest?.screen).toBe("profile_gmail_panel");
      expect(latest?.appRuntimeState.route.pathname).toBe(
        "/profile?panel=gmail&tab=account"
      );
      expect(latest?.oneVoiceContextSnapshot.revisions.route).toBeTruthy();
      expect(latest?.morphyAxSnapshot.context.screen).toBe("profile_gmail_panel");
      expect(latest?.morphyAxPresentation).toBe("idle");
    });
  });

  it("publishes onboarding journey cache writes without remounting the provider", async () => {
    mockPathname = "/one/setup";
    const seen: AgentRuntimeState[] = [];
    render(
      <AgentRuntimeStateProvider>
        <Probe onValue={(value) => seen.push(value)} />
      </AgentRuntimeStateProvider>
    );

    await waitFor(() => expect(seen.at(-1)?.oneVoiceContextSnapshot.onboarding.phase).toBe("setup_hub"));

    cacheMocks.values.set("pre-vault:user_1", {
      userId: "user_1",
      phoneVerified: true,
      setupCompleted: false,
      setupCapabilityIds: ["gmail"],
      onboardingPhase: "external_connector",
      onboardingActiveCapability: "gmail",
      onboardingCallbackState: "pending",
    });
    act(() => {
      for (const listener of cacheMocks.listeners) {
        listener({ type: "set", key: "pre-vault:user_1" });
      }
    });

    await waitFor(() => {
      const onboarding = seen.at(-1)?.oneVoiceContextSnapshot.onboarding;
      // The verified current setup-hub route remains phase authority, while
      // durable connector/capability progress refreshes immediately.
      expect(onboarding?.phase).toBe("setup_hub");
      expect(onboarding?.active_capability).toBe("gmail");
      expect(onboarding?.callback_state).toBe("pending");
      expect(onboarding?.setup_capability_ids).toEqual(["gmail"]);
    });
  });
});
