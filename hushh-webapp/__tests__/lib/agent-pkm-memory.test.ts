import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Module-level mocks ──────────────────────────────────────────────────────
// Mock ApiService so that previewAgentPkmMemory never makes real HTTP calls.
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
  },
}));

// Mock PkmWriteCoordinator so savePreparedDomain is controllable.
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    savePreparedDomain: vi.fn(),
  },
}));

// Mock AgentPkmContextStore so invalidateUser is trackable.
vi.mock("@/lib/agent/agent-pkm-context-store", () => ({
  AgentPkmContextStore: {
    invalidateUser: vi.fn(),
    clear: vi.fn(),
    peek: vi.fn(),
    load: vi.fn(),
  },
}));

import { ApiService } from "@/lib/services/api-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import {
  previewAgentPkmUpdate,
  saveAgentPkmUpdate,
} from "@/lib/agent/agent-pkm-memory";

// ─── Task 1: applyFieldPatch ─────────────────────────────────────────────────
// applyFieldPatch is module-private (not exported), so we test it indirectly
// through saveAgentPkmUpdate's build callback. We also validate it directly by
// capturing the build callback's execution in saveAgentPkmUpdate tests.

// ─── Task 1: previewAgentPkmUpdate ──────────────────────────────────────────
describe("previewAgentPkmUpdate", () => {
  const baseParams = {
    userId: "user-123",
    domain: "professional",
    fieldPath: "profile.name",
    currentValue: "Alice",
    proposedValue: "Alice Smith",
    currentDomains: ["professional"],
    vaultOwnerToken: "tok-abc",
  };

  const mockApiResponse = {
    agent_id: "pkm-agent",
    agent_name: "PKM Agent",
    model: "claude-3",
    used_fallback: false,
    preview_cards: [],
  };

  beforeEach(() => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockApiResponse,
    } as Response);
  });

  it("calls previewAgentPkmMemory with a message containing domain, fieldPath, currentValue, and proposedValue", async () => {
    await previewAgentPkmUpdate(baseParams);

    expect(ApiService.apiFetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(ApiService.apiFetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);

    // The message must contain all four slot values.
    expect(body.message).toContain("professional");
    expect(body.message).toContain("profile.name");
    expect(body.message).toContain("Alice");
    expect(body.message).toContain("Alice Smith");
  });

  it("constructs the expected message format", async () => {
    await previewAgentPkmUpdate(baseParams);

    const [, init] = vi.mocked(ApiService.apiFetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);

    // Message should match: Update {domain} - {fieldPath}: change from "{currentValue}" to "{proposedValue}"
    expect(body.message).toBe(
      'Update professional - profile.name: change from "Alice" to "Alice Smith"'
    );
  });

  it("passes userId, currentDomains, and vaultOwnerToken to the underlying fetch", async () => {
    await previewAgentPkmUpdate(baseParams);

    const [, init] = vi.mocked(ApiService.apiFetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);

    expect(body.user_id).toBe("user-123");
    expect(body.current_domains).toEqual(["professional"]);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok-abc",
    });
  });

  it("returns the same shape as previewAgentPkmMemory (with cards array)", async () => {
    const result = await previewAgentPkmUpdate(baseParams);

    expect(result).toHaveProperty("cards");
    expect(Array.isArray(result.cards)).toBe(true);
    expect(result.agent_id).toBe("pkm-agent");
  });

  it("sends a structured update_intent so the confirm decision is deterministic (GAP 1)", async () => {
    await previewAgentPkmUpdate(baseParams);

    const [, init] = vi.mocked(ApiService.apiFetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);

    // The structured slots must travel to the backend (not only the synthetic
    // sentence) so routing + confirm_first are derived deterministically rather
    // than re-classified by the LLM from machine-built text.
    expect(body.update_intent).toEqual({
      domain: "professional",
      field_path: "profile.name",
      current_value: "Alice",
      proposed_value: "Alice Smith",
    });
  });
});

// ─── Task 2: saveAgentPkmUpdate ─────────────────────────────────────────────
describe("saveAgentPkmUpdate", () => {
  const baseParams = {
    userId: "user-123",
    domain: "professional",
    fieldPath: "profile.name",
    proposedValue: "Alice Smith",
    vaultKey: "vault-key-xyz",
    vaultOwnerToken: "tok-abc",
  };

  const mockSaveResult = {
    saveState: "saved" as const,
    success: true,
    fullBlob: {},
  };

  beforeEach(() => {
    vi.mocked(PkmWriteCoordinator.savePreparedDomain).mockResolvedValue(
      mockSaveResult
    );
  });

  it("calls savePreparedDomain with the correct domain, userId, vaultKey, and vaultOwnerToken", async () => {
    await saveAgentPkmUpdate(baseParams);

    expect(PkmWriteCoordinator.savePreparedDomain).toHaveBeenCalledOnce();
    const [callArgs] = vi.mocked(PkmWriteCoordinator.savePreparedDomain).mock.calls[0];

    expect(callArgs.domain).toBe("professional");
    expect(callArgs.userId).toBe("user-123");
    expect(callArgs.vaultKey).toBe("vault-key-xyz");
    expect(callArgs.vaultOwnerToken).toBe("tok-abc");
  });

  it("passes a build callback that applies applyFieldPatch to context.currentDomainData", async () => {
    await saveAgentPkmUpdate(baseParams);

    const [callArgs] = vi.mocked(PkmWriteCoordinator.savePreparedDomain).mock.calls[0];
    const mockContext = {
      currentDomainData: { profile: { name: "Alice", age: 30 } },
      currentManifest: null,
      currentEncryptedDomain: null,
      baseFullBlob: {},
      attempt: 0,
      upgradedInSession: false,
    };

    const plan = await callArgs.build(mockContext);

    // applyFieldPatch should have set "profile.name" to "Alice Smith" without mutating the original
    expect((plan.domainData as Record<string, unknown>).profile).toEqual({
      name: "Alice Smith",
      age: 30,
    });
    // Original must not be mutated
    expect(
      (mockContext.currentDomainData.profile as Record<string, unknown>).name
    ).toBe("Alice");
  });

  it("build callback returns summary with source: agent_chat_update, field_path, and proposed_value", async () => {
    await saveAgentPkmUpdate(baseParams);

    const [callArgs] = vi.mocked(PkmWriteCoordinator.savePreparedDomain).mock.calls[0];
    const mockContext = {
      currentDomainData: {},
      currentManifest: null,
      currentEncryptedDomain: null,
      baseFullBlob: {},
      attempt: 0,
      upgradedInSession: false,
    };

    const plan = await callArgs.build(mockContext);

    expect(plan.summary).toMatchObject({
      source: "agent_chat_update",
      field_path: "profile.name",
      proposed_value: "Alice Smith",
    });
  });

  it("calls AgentPkmContextStore.invalidateUser(userId) after a successful write", async () => {
    await saveAgentPkmUpdate(baseParams);

    expect(AgentPkmContextStore.invalidateUser).toHaveBeenCalledOnce();
    expect(AgentPkmContextStore.invalidateUser).toHaveBeenCalledWith("user-123");
  });

  it("propagates errors from savePreparedDomain without swallowing them", async () => {
    vi.mocked(PkmWriteCoordinator.savePreparedDomain).mockRejectedValue(
      new Error("write failed")
    );

    await expect(saveAgentPkmUpdate(baseParams)).rejects.toThrow("write failed");
    // invalidateUser must NOT be called on failure
    expect(AgentPkmContextStore.invalidateUser).not.toHaveBeenCalled();
  });

  it("does not call invalidateUser when savePreparedDomain rejects", async () => {
    vi.mocked(PkmWriteCoordinator.savePreparedDomain).mockRejectedValue(
      new Error("network error")
    );

    await expect(saveAgentPkmUpdate(baseParams)).rejects.toThrow();
    expect(AgentPkmContextStore.invalidateUser).not.toHaveBeenCalled();
  });

  it("returns the PkmWriteCoordinatorResult from savePreparedDomain", async () => {
    const result = await saveAgentPkmUpdate(baseParams);

    expect(result).toBe(mockSaveResult);
  });
});

// ─── applyFieldPatch behaviour tests (via saveAgentPkmUpdate's build callback) ──
describe("applyFieldPatch (via saveAgentPkmUpdate build callback)", () => {
  beforeEach(() => {
    vi.mocked(PkmWriteCoordinator.savePreparedDomain).mockResolvedValue({
      saveState: "saved",
      success: true,
      fullBlob: {},
    });
  });

  async function getBuildPlan(fieldPath: string, proposedValue: string, currentDomainData: Record<string, unknown>) {
    await saveAgentPkmUpdate({
      userId: "u1",
      domain: "d",
      fieldPath,
      proposedValue,
      vaultKey: "vk",
      vaultOwnerToken: "vt",
    });
    const [callArgs] = vi.mocked(PkmWriteCoordinator.savePreparedDomain).mock.calls[0];
    const plan = await callArgs.build({
      currentDomainData,
      currentManifest: null,
      currentEncryptedDomain: null,
      baseFullBlob: {},
      attempt: 0,
      upgradedInSession: false,
    });
    return plan.domainData as Record<string, unknown>;
  }

  it("creates nested objects for a three-level path on empty data", async () => {
    const result = await getBuildPlan("a.b.c", "v", {});
    expect(result).toEqual({ a: { b: { c: "v" } } });
  });

  it("preserves sibling keys when setting a nested path", async () => {
    const result = await getBuildPlan("a.b.c", "v", { a: { b: { x: 1 } } });
    expect((result.a as Record<string, unknown>).b).toEqual({ x: 1, c: "v" });
  });

  it("overwrites an existing top-level key", async () => {
    const result = await getBuildPlan("name", "new", { name: "old" });
    expect(result.name).toBe("new");
  });

  it("does not mutate the original object (structuredClone guard)", async () => {
    const original: Record<string, unknown> = { profile: { name: "Alice" } };
    await getBuildPlan("profile.name", "Bob", original);
    expect((original.profile as Record<string, unknown>).name).toBe("Alice");
  });
});
