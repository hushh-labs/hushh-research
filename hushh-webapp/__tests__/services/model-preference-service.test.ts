import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({ privateAgent: vi.fn(), selection: vi.fn() }));
vi.mock("@/lib/services/pod-app-access", () => ({ usesOwnerPod: mocks.privateAgent }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getPersonalAgentStatus: vi.fn() } }));
vi.mock("@/lib/one/ai-selection-agent", () => ({ readAgentAiSelection: mocks.selection }));
import { ModelPreferenceService } from "@/lib/services/model-preference-service";

const shared = { user_id: "owner-a", selected_model: null, effective_model: "shared-model",
  source: "deployment", choices: [{ model_id: "shared-model", label: "Shared", is_default: true, is_active: true }] };
const fetcher = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-a");
  mocks.privateAgent.mockResolvedValue(false);
  mocks.selection.mockResolvedValue(null);
  fetcher.mockImplementation(async () => new Response(JSON.stringify(shared)));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("model preference follows chat placement", () => {
  it("retains confirmed Shared discovery and changes", async () => {
    expect(await ModelPreferenceService.get("id-token")).toEqual(shared);
    await ModelPreferenceService.set("id-token", "shared-model");
    expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ model_id: "shared-model" });
    expect(mocks.selection).not.toHaveBeenCalled();
  });

  it.each(["gemini", "openai", "azure_openai"])("reads the private %s choice without exposing Shared choices", async (provider) => {
    mocks.privateAgent.mockResolvedValue(true);
    mocks.selection.mockResolvedValue({ configured: true, provider, model: "owner-model", lastFailure: null });
    expect(await ModelPreferenceService.get("id-token")).toMatchObject({ source: "owner_pod", effective_model: "owner-model", choices: [] });
    expect(mocks.selection).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, { configured: false }, { configured: true, model: "owner-model", lastFailure: "KEY_REFUSED" }])("does not invent a catalog from unavailable/default metadata", async (selection) => {
    mocks.privateAgent.mockResolvedValue(true);
    mocks.selection.mockResolvedValue(selection);
    expect(await ModelPreferenceService.get("id-token")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses private writes and unavailable placement without a hub fallback", async () => {
    mocks.privateAgent.mockResolvedValue(true);
    await expect(ModelPreferenceService.set("id-token", "shared-model")).rejects.toThrow("OWNER_POD_MODEL_SELECTION_SETTINGS");
    mocks.privateAgent.mockRejectedValue(new Error("AGENT_PRIVATE_RUNTIME_REQUIRED"));
    await expect(ModelPreferenceService.get("id-token")).rejects.toThrow("AGENT_PRIVATE_RUNTIME_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses owner replacement while discovery is pending, including same-UID re-entry", async () => {
    fetcher.mockImplementationOnce(async () => {
      publishValidatedAuthSessionOwner(null);
      publishValidatedAuthSessionOwner("owner-a");
      return new Response(JSON.stringify(shared));
    });
    await expect(ModelPreferenceService.get("id-token")).rejects.toThrow("MODEL_PREFERENCE_OWNER_CHANGED");
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...shared, user_id: "owner-b" })));
    await expect(ModelPreferenceService.get("id-token")).rejects.toThrow("MODEL_PREFERENCE_OWNER_CHANGED");
  });
});
