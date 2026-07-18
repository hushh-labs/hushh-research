import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultMethodPrompt } from "@/components/vault/vault-method-prompt";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/profile",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    loading: false,
    user: {
      uid: "user-1",
      displayName: "Test User",
      email: "test@example.com",
    },
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "vault-key",
    isVaultUnlocked: true,
  }),
}));

vi.mock("@/lib/hooks/use-hostname", () => ({
  useHostname: () => "app.example.com",
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    getVaultState: vi.fn(() =>
      Promise.resolve({
        primaryMethod: "passphrase",
        wrappers: [],
      }),
    ),
    getWrapperByMethod: vi.fn(() => null),
  },
}));

vi.mock("@/lib/services/vault-method-service", () => ({
  VaultMethodService: {
    getCapabilityMatrix: vi.fn(() =>
      Promise.resolve({
        recommendedMethod: "generated_default_web_prf",
      }),
    ),
    switchMethod: vi.fn(),
  },
}));

vi.mock("@/lib/services/vault-method-prompt-local-service", () => ({
  VaultMethodPromptLocalService: {
    load: vi.fn(() => Promise.resolve(null)),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/services/kai-nav-tour-local-service", () => ({
  KaiNavTourLocalService: {
    load: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("VaultMethodPrompt", () => {
  it("covers method action button type", async () => {
    render(<VaultMethodPrompt enabled />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: "Not now" }).getAttribute("type")).toBe(
      "button",
    );
    expect(
      screen.getByRole("button", { name: "Enable now" }).getAttribute("type"),
    ).toBe("button");
  });
});
