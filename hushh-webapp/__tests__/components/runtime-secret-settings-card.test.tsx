import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { RuntimeSecretSettingsCard } from "@/components/profile/runtime-secret-settings-card";
import {
  KAI_GEMINI_RUNTIME_CREDENTIAL_REF,
  KAI_RUNTIME_CREDENTIAL_MODE_REF,
  PersonalKnowledgeModelService,
} from "@/lib/services/personal-knowledge-model-service";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("RuntimeSecretSettingsCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("saves a Gemini key through the runtime secret service without rendering the raw key after save", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadRuntimeSecret").mockResolvedValue(null);
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeRuntimeSecret")
      .mockResolvedValue({ success: true });

    render(
      <RuntimeSecretSettingsCard
        userId="user-1"
        vaultKey="vault-key-1"
        vaultOwnerToken="vault-owner-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(PersonalKnowledgeModelService.loadRuntimeSecret).toHaveBeenCalledWith({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: KAI_GEMINI_RUNTIME_CREDENTIAL_REF,
      }),
    );

    const rawKey = "gemini-ui-key-123";
    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: rawKey },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(storeSpy).toHaveBeenCalledWith({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: KAI_GEMINI_RUNTIME_CREDENTIAL_REF,
        secret: rawKey,
      }),
    );
    expect((screen.getByLabelText("Gemini API key") as HTMLInputElement).value).toBe("");
    expect(screen.queryByDisplayValue(rawKey)).toBeNull();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("routes locked users to vault unlock instead of storing a key", () => {
    const unlock = vi.fn();
    const storeSpy = vi.spyOn(PersonalKnowledgeModelService, "storeRuntimeSecret");

    render(
      <RuntimeSecretSettingsCard
        userId="user-1"
        vaultKey={null}
        vaultOwnerToken={null}
        needsVaultCreation={false}
        needsUnlock
        onRequestVaultUnlock={unlock}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("stores the model access mode toggle in encrypted runtime secrets", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadRuntimeSecret").mockImplementation(
      async ({ credentialRef }) =>
        credentialRef === KAI_RUNTIME_CREDENTIAL_MODE_REF ? "byok" : null,
    );
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeRuntimeSecret")
      .mockResolvedValue({ success: true });

    render(
      <RuntimeSecretSettingsCard
        userId="user-1"
        vaultKey="vault-key-1"
        vaultOwnerToken="vault-owner-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    const toggle = await screen.findByRole("switch", {
      name: "Use Hushh managed Gemini",
    });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(storeSpy).toHaveBeenCalledWith({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: KAI_RUNTIME_CREDENTIAL_MODE_REF,
        secret: "hushh_managed_vertex",
      }),
    );
  });
});
