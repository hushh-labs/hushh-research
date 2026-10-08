/**
 * Risk 2 (unpaid Gemini key in a private agent). Google's Gemini API terms say
 * unpaid use may improve Google products and may be read by human reviewers.
 * Hussh cannot tell a paid key from an unpaid one, so the note is shown for
 * every Google AI Studio Gemini key and never claims a check. What these pin:
 * the note is on the Gemini key entry, it leaves with the Vertex endpoint (a
 * billed Google Cloud project), and another provider's key never carries it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GEMINI_FREE_TIER_NOTE } from "@/components/connections/gemini-free-tier-note";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { OpenAiKeyCard } from "@/components/connections/openai-key-card";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";

const mocks = vi.hoisted(() => ({
  loadRuntimeSecret: vi.fn(),
  getByocSetupStatus: vi.fn(),
  loadAgentAiState: vi.fn(),
  hasSavedOpenAiKey: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getByocSetupStatus: (...args: unknown[]) => mocks.getByocSetupStatus(...args),
    validateGeminiRuntimeCredential: vi.fn(),
    selectManagedGeminiRuntime: vi.fn(),
    apiFetch: vi.fn(),
    getFirebaseIdToken: async () => "firebase-token",
  },
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "pkm:runtime_secrets.llm.gemini_api_key",
  GEMINI_RUNTIME_TRANSPORT_REF: "pkm:runtime_secrets.llm.gemini_transport",
  GEMINI_VERTEX_LOCATION_REF: "pkm:runtime_secrets.llm.gemini_vertex_location",
  GEMINI_VERTEX_PROJECT_REF: "pkm:runtime_secrets.llm.gemini_vertex_project",
  RUNTIME_CREDENTIAL_MODE_REF: "pkm:runtime_secrets.llm.credential_mode",
  PersonalKnowledgeModelService: {
    loadRuntimeSecret: (...args: unknown[]) => mocks.loadRuntimeSecret(...args),
    storeRuntimeSecret: vi.fn(),
    removeRuntimeSecret: vi.fn(),
  },
}));
vi.mock("@/lib/one/ai-selection-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/one/ai-selection-agent")>()),
  loadAgentAiState: mocks.loadAgentAiState,
}));
vi.mock("@/lib/one/ai-selection-vault", () => ({
  loadSelectedAiProvider: vi.fn().mockResolvedValue(null),
  hasSavedOpenAiKey: mocks.hasSavedOpenAiKey,
  recordOpenAiSelection: vi.fn(),
  removeOpenAiSelection: vi.fn(),
}));

const VAULT_PROPS = {
  vaultKey: "vault-key-fixture",
  vaultOwnerToken: "owner-token-fixture",
  needsVaultCreation: false,
  needsUnlock: false,
  onRequestVaultUnlock: vi.fn(),
  onRequestVaultCreation: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  CacheService.getInstance().clear();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-1");
  mocks.loadRuntimeSecret.mockResolvedValue(null);
  mocks.getByocSetupStatus.mockResolvedValue({ status: "not_started", projectId: null });
  mocks.loadAgentAiState.mockResolvedValue({ readiness: { kind: "ready" }, selection: null });
  mocks.hasSavedOpenAiKey.mockResolvedValue(false);
});

describe("Gemini free-tier note", () => {
  it("shows the paid-key note where a Gemini key is entered, and drops it for a Vertex key", async () => {
    render(
      <GeminiRuntimeSettingsCard userId="owner-1" {...VAULT_PROPS} requiresExplicitSelection
        initiallyConfigured initialSetupChoice="byok_pending_vault" />,
    );
    fireEvent.click((await screen.findAllByRole("radio"))[1]);
    expect(await screen.findByLabelText("Gemini API key")).toBeInTheDocument();
    expect(screen.getByTestId("gemini-free-tier-note")).toHaveTextContent(GEMINI_FREE_TIER_NOTE);
    // Honest, not a guess: the note never claims Hussh checked the key's tier.
    expect(GEMINI_FREE_TIER_NOTE).not.toMatch(/detect|checked|your key is (free|unpaid)/i);
    expect(GEMINI_FREE_TIER_NOTE).not.toContain(String.fromCharCode(0x2014));

    fireEvent.change(screen.getByLabelText("API endpoint"), { target: { value: "vertex_api_key" } });
    expect(screen.queryByTestId("gemini-free-tier-note")).toBeNull();
  });

  it("never shows the Gemini note on another provider's key card", async () => {
    render(<OpenAiKeyCard userId="owner-1" {...VAULT_PROPS} defaultModel={null} />);
    expect(await screen.findByLabelText("OpenAI API key")).toBeInTheDocument();
    expect(screen.queryByTestId("gemini-free-tier-note")).toBeNull();
    expect(screen.queryByText(GEMINI_FREE_TIER_NOTE)).toBeNull();
  });
});
