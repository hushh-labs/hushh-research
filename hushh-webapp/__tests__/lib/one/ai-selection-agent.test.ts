/**
 * The agent client for Bring your own AI: the C3 capability decides what the
 * person is offered, C2 refusals arrive as stable codes, and clearing is scoped
 * so removing one provider's key never ends another provider's active choice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentAiReadiness,
  clearAgentAiSelectionFor,
  sendAiSelectionToAgent,
  shareGeminiSelectionWithAgent,
} from "@/lib/one/ai-selection-agent";

const mocks = vi.hoisted(() => ({ status: vi.fn(), pod: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: mocks.status, ownerPodRequest: mocks.pod },
}));
vi.mock("@/lib/one/ai-selection-vault", () => ({ recordSelectedAiProvider: mocks.record }));

const CAPABLE = { hostingMode: "byoc", state: "active", aiSelection: { version: 1, providers: ["gemini", "openai"] } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const OPENAI = { provider: "openai", model: null, apiKey: "sk-fixture", transport: null, vertexProject: null, vertexLocation: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue(undefined);
});

describe("ai-selection agent client", () => {
  it("reads the C3 capability: no agent, too old (with the offered update), or ready", () => {
    expect(agentAiReadiness({ hostingMode: "shared" }, "openai")).toEqual({ kind: "no_agent" });
    expect(agentAiReadiness({ hostingMode: "byoc", state: "active", aiSelection: null }, "openai")).toEqual({
      kind: "needs_update",
      update: { releaseId: null, deploymentTarget: null, installable: false, working: false },
    });
    const older = agentAiReadiness({
      hostingMode: "byoc", state: "active", deploymentTarget: "user_gcp", updateInstallable: true,
      aiSelection: { version: 1, providers: ["gemini"] },
      update: { releaseId: "rel_fixture", summary: "", presentationState: "ready" },
    }, "openai");
    expect(older).toMatchObject({ kind: "needs_update", update: { releaseId: "rel_fixture", installable: true } });
    expect(agentAiReadiness(CAPABLE as never, "openai")).toEqual({ kind: "ready" });
  });

  it("maps C2 refusals to stable codes", async () => {
    mocks.pod.mockResolvedValueOnce(json({ detail: { code: "KEY_REFUSED" } }, 422));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({ ok: false, code: "KEY_REFUSED" });
    mocks.pod.mockResolvedValueOnce(json({ code: "QUOTA_EXCEEDED" }, 422));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({ ok: false, code: "QUOTA_EXCEEDED" });
    mocks.pod.mockResolvedValueOnce(json({ detail: "Not Found" }, 404));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({ ok: false, code: "PROVIDER_UNSUPPORTED" });
    mocks.pod.mockRejectedValueOnce(new Error("AGENT_KEY_MISMATCH"));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({ ok: false, code: "AGENT_KEY_CHANGED" });
    mocks.pod.mockResolvedValueOnce(json({ status: "active", provider: "openai", model: "gpt-fixture", checkedAtMs: 5 }));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({ ok: true, provider: "openai", model: "gpt-fixture", checkedAtMs: 5 });
  });

  it("removing the Gemini key clears only a Gemini selection, never an active OpenAI one", async () => {
    mocks.status.mockResolvedValue(CAPABLE);
    mocks.pod.mockResolvedValueOnce(json({ configured: true, provider: "openai", model: null, checkedAtMs: 1, lastFailure: null }));
    expect(await clearAgentAiSelectionFor("gemini")).toBe("not_needed");
    expect(mocks.pod).toHaveBeenCalledTimes(1);
    expect(mocks.pod.mock.calls[0][1]).toMatchObject({ method: "GET" });

    mocks.pod.mockReset();
    mocks.pod
      .mockResolvedValueOnce(json({ configured: true, provider: "gemini", model: null, checkedAtMs: 1, lastFailure: null }))
      .mockResolvedValueOnce(json({ status: "cleared" }));
    expect(await clearAgentAiSelectionFor("gemini")).toBe("cleared");
    expect(mocks.pod.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
  });

  it("seals a saved Gemini key only to an agent that takes sealed selections", async () => {
    const input = { userId: "owner-1", vaultKey: "k", vaultOwnerToken: "t", credential: "gemini-fixture", transport: "developer_api" as const, vertexProject: "p", vertexLocation: "l" };
    mocks.status.mockResolvedValueOnce({ hostingMode: "byoc", state: "active" });
    expect(await shareGeminiSelectionWithAgent(input)).toBeNull();
    expect(mocks.pod).not.toHaveBeenCalled();

    mocks.status.mockResolvedValueOnce(CAPABLE);
    mocks.pod.mockResolvedValueOnce(json({ status: "active", provider: "gemini", model: null, checkedAtMs: 1 }));
    expect(await shareGeminiSelectionWithAgent(input)).toBeNull();
    expect(JSON.parse(String(mocks.pod.mock.calls[0][1].body))).toEqual({
      provider: "gemini", model: null, apiKey: "gemini-fixture", transport: "developer_api", vertexProject: null, vertexLocation: null,
    });
    expect(mocks.record).toHaveBeenCalledWith(input, "gemini");
  });
});
