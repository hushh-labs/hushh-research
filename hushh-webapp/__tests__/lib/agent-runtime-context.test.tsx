import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentRuntimeStateProvider,
  useAgentRuntimeState,
  type AgentRuntimeState,
} from "@/lib/agent/agent-runtime-context";

let mockPathname = "/profile";

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
  },
  CacheService: {
    getInstance: () => ({
      get: () => null,
      subscribe: () => () => undefined,
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
    });
  });
});
