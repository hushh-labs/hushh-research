import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { RuntimeSecretSettingsCard } from "@/components/profile/runtime-secret-settings-card";
import {
  GEMINI_RUNTIME_CREDENTIAL_REF,
  OPENAI_RUNTIME_CREDENTIAL_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
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
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
      }),
    );

    const rawKey = "gemini-ui-key-123";
    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: rawKey },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() =>
      expect(storeSpy).toHaveBeenCalledWith({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
        secret: rawKey,
      }),
    );
    expect((screen.getByLabelText("Gemini API key") as HTMLInputElement).value).toBe("");
    expect(screen.queryByDisplayValue(rawKey)).toBeNull();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByPlaceholderText("••••••••••••••••")).toBeTruthy();
  });

  it("saves additional provider keys through encrypted runtime secrets", async () => {
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

    expect(await screen.findByLabelText("Claude API key")).toBeTruthy();
    expect(screen.getByLabelText("Grok API key")).toBeTruthy();
    expect(screen.getByLabelText("OpenAI API key")).toBeTruthy();

    const rawKey = "openai-ui-key-123";
    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: rawKey },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[3]);

    await waitFor(() =>
      expect(storeSpy).toHaveBeenCalledWith({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: OPENAI_RUNTIME_CREDENTIAL_REF,
        secret: rawKey,
      }),
    );
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

    fireEvent.click(screen.getAllByRole("button", { name: "Unlock vault" })[0]);

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("reveals the saved Gemini key from encrypted runtime secrets after vault unlock", async () => {
    const savedKey = "saved-gemini-key-456";
    vi.spyOn(PersonalKnowledgeModelService, "loadRuntimeSecret").mockImplementation(
      async ({ credentialRef }) => {
        if (credentialRef === GEMINI_RUNTIME_CREDENTIAL_REF) {
          return savedKey;
        }
        if (credentialRef === RUNTIME_CREDENTIAL_MODE_REF) {
          return "byok";
        }
        return null;
      },
    );

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

    await screen.findByText("Saved");
    expect(screen.queryByDisplayValue(savedKey)).toBeNull();
    expect(screen.getByPlaceholderText("••••••••••••••••")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show Gemini API key" }));

    await waitFor(() =>
      expect(screen.getByDisplayValue(savedKey)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide Gemini API key" }));

    expect(screen.queryByDisplayValue(savedKey)).toBeNull();
  });

  it("stores the model access mode toggle in encrypted runtime secrets", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadRuntimeSecret").mockImplementation(
      async ({ credentialRef }) =>
        credentialRef === RUNTIME_CREDENTIAL_MODE_REF ? "byok" : null,
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
        credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
        secret: "hushh_managed_vertex",
      }),
    );
  });

  it("defaults to Hushh managed Gemini when no runtime mode is saved", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadRuntimeSecret").mockResolvedValue(null);

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
    expect((toggle as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
  });

  it("lets users update the Gemini key while Hushh managed Gemini is selected", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadRuntimeSecret").mockImplementation(
      async ({ credentialRef }) => {
        if (credentialRef === GEMINI_RUNTIME_CREDENTIAL_REF) {
          return "saved-gemini-key";
        }
        if (credentialRef === RUNTIME_CREDENTIAL_MODE_REF) {
          return "hushh_managed_vertex";
        }
        return null;
      },
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

    const input = await screen.findByLabelText("Gemini API key");
    expect((input as HTMLInputElement).disabled).toBe(false);

    const replacementKey = "replacement-gemini-key";
    fireEvent.change(input, { target: { value: replacementKey } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() =>
      expect(storeSpy).toHaveBeenCalledWith({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
        secret: replacementKey,
      }),
    );
  });

  it("removes a saved Gemini key through encrypted runtime secrets", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadRuntimeSecret").mockImplementation(
      async ({ credentialRef }) =>
        credentialRef === GEMINI_RUNTIME_CREDENTIAL_REF ? "saved-gemini-key" : null,
    );
    const removeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "removeRuntimeSecret")
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

    await screen.findByText("Saved");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove saved Gemini API key" }),
    );

    await waitFor(() =>
      expect(removeSpy).toHaveBeenCalledWith({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
      }),
    );
    expect(screen.getAllByText("Not set").length).toBeGreaterThan(0);
  });
});
