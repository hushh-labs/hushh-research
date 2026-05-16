import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PersonaBootstrapRedirect } from "@/components/iam/persona-bootstrap-redirect";

const replace = vi.fn();
const switchPersona = vi.fn();

let personaStateValue: Record<string, unknown> = {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/kai",
  useRouter: () => ({
    replace,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1" },
    isAuthenticated: true,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
  }),
}));

vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: (selector: (state: { lastKaiPath: string; lastRiaPath: string }) => unknown) =>
    selector({
      lastKaiPath: "/kai",
      lastRiaPath: "/ria",
    }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => personaStateValue,
}));

describe("PersonaBootstrapRedirect", () => {
  beforeEach(() => {
    replace.mockReset();
    switchPersona.mockReset();
    personaStateValue = {
      personaState: {
        active_persona: "ria",
        last_active_persona: "ria",
        primary_nav_persona: "ria",
      },
      activePersona: "ria",
      loading: false,
      personaTransitionTarget: null,
      refreshing: false,
      riaCapability: "switch",
      riaEntryRoute: "/ria",
      switchPersona,
    };
  });

  it("shows the mismatch dialog when route and persona are out of sync", () => {
    render(<PersonaBootstrapRedirect />);

    expect(
      screen.getByText("Your active role and current route are out of sync")
    ).toBeTruthy();
  });

  it("suppresses the mismatch dialog during an intentional persona transition", () => {
    personaStateValue = {
      ...personaStateValue,
      personaTransitionTarget: "ria",
    };

    render(<PersonaBootstrapRedirect />);

    expect(
      screen.queryByText("Your active role and current route are out of sync")
    ).toBeNull();
  });
});
