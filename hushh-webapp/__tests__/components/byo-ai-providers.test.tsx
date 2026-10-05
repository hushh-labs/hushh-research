/**
 * Bring your own AI beyond Gemini. What these pin: the agent's live check is
 * the validation and the Vault records only a selection the agent accepted;
 * every refusal reaches the person as plain copy; a key the agent may still be
 * using is never reported removed; an agent too old for OpenAI is offered the
 * existing owner-approved update; and a provider this build cannot configure
 * is shown but never selectable.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BringYourOwnAiProviders } from "@/components/connections/byo-ai-providers";
import { OpenAiKeyCard } from "@/components/connections/openai-key-card";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { resolveRuntimeProviderCatalog } from "@/lib/connections/runtime-provider-catalog-client";
import { ROUTES } from "@/lib/navigation/routes";
import { CacheService } from "@/lib/services/cache-service";

const mocks = vi.hoisted(() => ({
  loadAgentAiState: vi.fn(),
  send: vi.fn(),
  clear: vi.fn(),
  clearFor: vi.fn(),
  hasSavedKey: vi.fn(),
  record: vi.fn(),
  remove: vi.fn(),
  approve: vi.fn(),
  apiFetch: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { success: mocks.toastSuccess, error: mocks.toastError, promise: vi.fn() },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch, getFirebaseIdToken: async () => "firebase-token" },
}));
vi.mock("@/lib/one/ai-selection-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/one/ai-selection-agent")>()),
  loadAgentAiState: mocks.loadAgentAiState,
  sendAiSelectionToAgent: mocks.send,
  clearAgentAiSelection: mocks.clear,
  clearAgentAiSelectionFor: mocks.clearFor,
}));
vi.mock("@/lib/one/ai-selection-vault", () => ({
  hasSavedOpenAiKey: mocks.hasSavedKey,
  recordOpenAiSelection: mocks.record,
  removeOpenAiSelection: mocks.remove,
}));
vi.mock("@/lib/one/agent-update-approval", () => ({
  approveAgentUpdate: mocks.approve,
  agentUpdateApprovalToast: () => ({ loading: "", success: "", error: "" }),
}));

const VAULT = { userId: "owner-1", vaultKey: "vault-key-fixture", vaultOwnerToken: "owner-token-fixture" };
const READY = { readiness: { kind: "ready" }, selection: null };
const IN_USE = {
  readiness: { kind: "ready" },
  selection: { configured: true, provider: "openai", model: "gpt-fixture", checkedAtMs: 1, lastFailure: null },
};

function renderCard(overrides: Partial<Parameters<typeof OpenAiKeyCard>[0]> = {}) {
  const props = {
    ...VAULT,
    needsVaultCreation: false,
    needsUnlock: false,
    onRequestVaultUnlock: vi.fn(),
    onRequestVaultCreation: vi.fn(),
    defaultModel: null,
    ...overrides,
  };
  render(<OpenAiKeyCard {...props} />);
  return props;
}

async function submitKey(key = "sk-fixture-not-a-real-key") {
  fireEvent.change(await screen.findByLabelText("OpenAI API key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Check and use" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  CacheService.getInstance().clear();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-1");
  mocks.loadAgentAiState.mockResolvedValue(READY);
  mocks.hasSavedKey.mockResolvedValue(false);
  mocks.record.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(true);
  mocks.clearFor.mockResolvedValue("cleared");
});

describe("OpenAiKeyCard", () => {
  it("explains that an own key needs a private agent and links to setting one up", async () => {
    mocks.loadAgentAiState.mockResolvedValue({ readiness: { kind: "no_agent" }, selection: null });
    renderCard();
    expect(await screen.findByText(/Your own key runs on your private agent/)).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up your private agent" }));
    expect(mocks.push).toHaveBeenCalledWith(ROUTES.ONE_SETUP_CLOUD);
  });

  it("offers the existing owner-approved update when the agent is too old for OpenAI", async () => {
    mocks.loadAgentAiState.mockResolvedValue({
      readiness: { kind: "needs_update", update: { releaseId: "rel_fixture", deploymentTarget: "user_gcp", installable: true, working: false } },
      selection: null,
    });
    mocks.approve.mockResolvedValue("scheduled");
    renderCard();
    expect(await screen.findByText("Your agent needs an update to use OpenAI.")).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update your agent" }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(
      expect.objectContaining({ releaseId: "rel_fixture", deploymentTarget: "user_gcp" }),
    ));
  });

  it("asks the agent first, then records the accepted selection in the Vault", async () => {
    mocks.send.mockResolvedValue({ ok: true, provider: "openai", model: "gpt-fixture", checkedAtMs: 1 });
    renderCard();
    await screen.findByLabelText("OpenAI API key");
    mocks.loadAgentAiState.mockResolvedValue(IN_USE); // the agent now reports what it accepted
    await submitKey();
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Using OpenAI on your agent."));
    expect(mocks.send).toHaveBeenCalledWith({
      provider: "openai", model: null, apiKey: "sk-fixture-not-a-real-key", transport: null, vertexProject: null, vertexLocation: null,
    });
    expect(mocks.record).toHaveBeenCalledWith({ ...VAULT, apiKey: "sk-fixture-not-a-real-key", model: null });
    expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(mocks.record.mock.invocationCallOrder[0]);
    expect(await screen.findByText("In use")).toBeInTheDocument();
    expect(screen.getByText("Using OpenAI on your agent (gpt-fixture).")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
  });

  it.each([
    ["KEY_REFUSED", "OpenAI did not accept this key. Check it and try again."],
    ["QUOTA_EXCEEDED", "This OpenAI key is out of quota. Check your OpenAI account, then try again."],
    ["MODEL_UNAVAILABLE", "This OpenAI key cannot use the selected model. Check your OpenAI account, then try again."],
    ["PROVIDER_UNREACHABLE", "OpenAI could not be reached. Try again in a moment."],
    ["PROVIDER_UNSUPPORTED", "Your agent needs an update to use OpenAI."],
    ["STALE_SELECTION", "This setting changed on another device. Try again."],
    ["BAD_ENVELOPE", "Your agent could not read this request. Refresh the app and try again."],
    ["AGENT_UNREACHABLE", "Your private agent could not be reached. Try again in a moment."],
  ])("shows plain copy for %s and saves nothing", async (code, copy) => {
    mocks.send.mockResolvedValue({ ok: false, code });
    renderCard();
    await submitKey();
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("withdraws the agent's selection when the Vault cannot record it", async () => {
    mocks.send.mockResolvedValue({ ok: true, provider: "openai", model: null, checkedAtMs: 1 });
    mocks.record.mockRejectedValue(new Error("PKM_WRITE_FAILED"));
    renderCard();
    await submitKey();
    expect(await screen.findByRole("alert")).toHaveTextContent("your agent will not use it");
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("stops the agent before removing the key, and keeps the key when the agent cannot be reached", async () => {
    mocks.loadAgentAiState.mockResolvedValue(IN_USE);
    mocks.hasSavedKey.mockResolvedValue(true);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Your OpenAI key was removed."));
    expect(mocks.clearFor).toHaveBeenCalledWith("openai");
    expect(mocks.clearFor.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]);

    vi.clearAllMocks();
    mocks.loadAgentAiState.mockResolvedValue(IN_USE);
    mocks.clearFor.mockResolvedValue("failed");
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("may still use this key");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("asks for the vault before any key is taken", async () => {
    const props = renderCard({ vaultKey: null, needsUnlock: true });
    fireEvent.click(await screen.findByRole("button", { name: "Unlock your vault" }));
    expect(props.onRequestVaultUnlock).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
  });
});

describe("provider catalog (C5)", () => {
  const SERVER_CATALOG = {
    version: 1,
    providers: [
      { id: "gemini", name: "Google Gemini", availability: "available", methods: ["own_key"] },
      { id: "openai", name: "OpenAI", availability: "available", methods: ["own_key"], defaultModel: "gpt-fixture" },
      { id: "anthropic", name: "Claude", availability: "available", methods: ["oauth_link"] },
      { id: "mistral", name: "Mistral", availability: "available", methods: ["own_key"] },
      { id: "grok", name: "Grok", availability: "coming_soon", methods: [] },
    ],
  };

  it("offers only what this build can configure and shows the rest as a newer version", async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify(SERVER_CATALOG)));
    render(<BringYourOwnAiProviders {...VAULT} needsVaultCreation={false} needsUnlock={false}
      onRequestVaultUnlock={vi.fn()} onRequestVaultCreation={vi.fn()} />);
    expect(await screen.findByTestId("profile-openai-runtime")).toBeInTheDocument();
    for (const [id, name] of [["mistral", "Mistral"], ["anthropic", "Claude"]] as const) {
      const row = screen.getByTestId(`profile-newer-runtime-${id}`);
      expect(row).toHaveTextContent(name);
      expect(row).toHaveTextContent("Available in a newer version of Hussh.");
      expect(row).toHaveClass("cursor-not-allowed");
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByTestId("profile-coming-soon-grok")).toHaveTextContent("Grok");
    expect(screen.queryByTestId("profile-coming-soon-gemini")).toBeNull();
  });

  it("falls back to the bundled list, where OpenAI stays coming soon, when the server is unreachable", async () => {
    mocks.apiFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<BringYourOwnAiProviders {...VAULT} needsVaultCreation={false} needsUnlock={false}
      onRequestVaultUnlock={vi.fn()} onRequestVaultCreation={vi.fn()} />);
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    expect(screen.getByTestId("profile-coming-soon-openai")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-openai-runtime")).toBeNull();
  });

  it("refuses a payload that is not a catalog, and malformed entries inside one", () => {
    expect(resolveRuntimeProviderCatalog({ version: 1 })).toBeNull();
    expect(resolveRuntimeProviderCatalog({
      providers: [{ id: "Bad Id" }, null, { id: "openai", availability: "available", methods: ["own_key"] }, { id: "openai" }],
    })?.map((provider) => [provider.id, provider.state])).toEqual([["openai", "configurable"]]);
  });
});
