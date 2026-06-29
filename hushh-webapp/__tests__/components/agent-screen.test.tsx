import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentScreen } from "@/components/agent/agent-screen";

vi.mock("@/components/agent/agent-chat-workspace", () => ({
  AgentChatWorkspace: () => <div data-testid="agent-chat-workspace" />,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "agent-user" },
    loading: false,
  }),
}));

vi.mock("@/lib/testing/native-test", () => ({
  useNativeTestBeacon: vi.fn(),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    vaultOwnerToken: "vault-owner-token",
  }),
}));

describe("AgentScreen", () => {
  it("renders the native route marker contract", () => {
    const { container } = render(<AgentScreen />);

    const marker = container.querySelector('[data-native-route-marker="true"]');

    expect(marker).toBeTruthy();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
    expect(marker?.getAttribute("data-testid")).toBe("native-route-agent");
    expect(marker?.getAttribute("data-native-route-id")).toBe("/agent");
    expect(marker?.getAttribute("data-native-auth-default")).toBe("authenticated");
    expect(marker?.getAttribute("data-native-data-default")).toBe("loaded");
  });
});
