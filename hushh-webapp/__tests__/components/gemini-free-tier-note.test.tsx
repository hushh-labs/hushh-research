/** One refuses unverified Gemini-key processing; other provider controls remain independent. */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UNVERIFIED_GEMINI_KEY_MESSAGE } from "@/lib/one/ai-selection-agent";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { OpenAiKeyCard } from "@/components/connections/openai-key-card";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";

const mocks = vi.hoisted(() => ({
  loadRuntimeSecret: vi.fn(),
  getPersonalAgentStatus: vi.fn(),
  loadAgentAiState: vi.fn(),
  hasSavedOpenAiKey: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/one/setup/connections" }));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPersonalAgentStatus: (...args: unknown[]) => mocks.getPersonalAgentStatus(...args),
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
  mocks.getPersonalAgentStatus.mockResolvedValue({ hostingMode: "shared" });
  mocks.loadAgentAiState.mockResolvedValue({ readiness: { kind: "ready" }, selection: null });
  mocks.hasSavedOpenAiKey.mockResolvedValue(false);
});

describe("Gemini processing policy", () => {
  it("explains unverified processing and exposes no Gemini key selection", async () => {
    render(<GeminiRuntimeSettingsCard userId="owner-1" {...VAULT_PROPS} requiresExplicitSelection
      initiallyConfigured initialSetupChoice="byok_pending_vault" />);
    expect(await screen.findByText(UNVERIFIED_GEMINI_KEY_MESSAGE)).toBeVisible();
    expect(screen.queryByLabelText("Gemini API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check and use" })).toBeNull();
    expect(screen.queryByTestId("gemini-free-tier-note")).toBeNull();
  });

  it("never shows the Gemini note on another provider's key card", async () => {
    render(<OpenAiKeyCard userId="owner-1" {...VAULT_PROPS} defaultModel={null} />);
    expect(await screen.findByLabelText("OpenAI API key")).toBeInTheDocument();
    expect(screen.queryByTestId("gemini-free-tier-note")).toBeNull();
    expect(screen.queryByText(UNVERIFIED_GEMINI_KEY_MESSAGE)).toBeNull();
  });
});
