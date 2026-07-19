import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadRuntimeSecret: vi.fn() }));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "pkm:runtime_secrets.llm.gemini_api_key",
  GEMINI_RUNTIME_TRANSPORT_REF: "pkm:runtime_secrets.llm.gemini_transport",
  GEMINI_VERTEX_LOCATION_REF: "pkm:runtime_secrets.llm.gemini_vertex_location",
  GEMINI_VERTEX_PROJECT_REF: "pkm:runtime_secrets.llm.gemini_vertex_project",
  RUNTIME_CREDENTIAL_MODE_REF: "pkm:runtime_secrets.llm.credential_mode",
  PersonalKnowledgeModelService: { loadRuntimeSecret: mocks.loadRuntimeSecret },
}));

import { resolveGeminiRuntimeConnection } from "@/lib/connections/gemini-runtime-configuration";

describe("Gemini runtime configuration", () => {
  beforeEach(() => {
    mocks.loadRuntimeSecret.mockReset();
  });

  it("uses managed mode without attempting a vault read while locked", async () => {
    await expect(resolveGeminiRuntimeConnection({ userId: "user_1" })).resolves.toEqual({
      mode: "hushh_managed_vertex",
      credential: null,
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    });
    expect(mocks.loadRuntimeSecret).not.toHaveBeenCalled();
  });

  it("resolves an unlocked BYOK selection from the exact encrypted references", async () => {
    mocks.loadRuntimeSecret
      .mockResolvedValueOnce("byok")
      .mockResolvedValueOnce("test-key")
      .mockResolvedValueOnce("developer_api")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(
      resolveGeminiRuntimeConnection({
        userId: "user_1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toEqual({
      mode: "byok",
      credential: "test-key",
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    });

    expect(mocks.loadRuntimeSecret).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ credentialRef: "pkm:runtime_secrets.llm.credential_mode" }),
    );
    expect(mocks.loadRuntimeSecret).toHaveBeenCalledWith(
      expect.objectContaining({ credentialRef: "pkm:runtime_secrets.llm.gemini_api_key" }),
    );
  });

  it("uses the documented managed default when the encrypted mode cannot be read", async () => {
    mocks.loadRuntimeSecret.mockRejectedValueOnce(new Error("vault unavailable"));

    await expect(
      resolveGeminiRuntimeConnection({
        userId: "user_1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toEqual({
      mode: "hushh_managed_vertex",
      credential: null,
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    });
  });

  it("does not fall back to managed mode when a selected BYOK key cannot be read", async () => {
    mocks.loadRuntimeSecret
      .mockResolvedValueOnce("byok")
      .mockRejectedValueOnce(new Error("vault unavailable"));

    await expect(
      resolveGeminiRuntimeConnection({
        userId: "user_1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toEqual({
      mode: "byok",
      credential: null,
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    });
  });

  it("resolves a Google Cloud Vertex API key with its encrypted endpoint metadata", async () => {
    mocks.loadRuntimeSecret
      .mockResolvedValueOnce("byok")
      .mockResolvedValueOnce("test-key")
      .mockResolvedValueOnce("vertex_api_key")
      .mockResolvedValueOnce("customer-vertex-project")
      .mockResolvedValueOnce("us-central1");

    await expect(
      resolveGeminiRuntimeConnection({
        userId: "user_1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toEqual({
      mode: "byok",
      credential: "test-key",
      transport: "vertex_api_key",
      vertexProject: "customer-vertex-project",
      vertexLocation: "us-central1",
    });
  });
});
