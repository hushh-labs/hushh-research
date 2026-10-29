/**
 * The agent client for Bring your own AI: the C3 capability decides what the
 * person is offered, C2 refusals arrive as stable codes, and clearing is scoped
 * so removing one provider's key never ends another provider's active choice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

import {
  agentAiReadiness,
  aiSelectionRefusalMessage,
  clearAgentAiSelectionFor,
  sendAiSelectionToAgent,
  shareGeminiSelectionWithAgent,
  verifyAgentCloudAi,
} from "@/lib/one/ai-selection-agent";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  pod: vi.fn(),
  record: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPersonalAgentStatus: mocks.status,
    ownerPodRequest: mocks.pod,
  },
}));
vi.mock("@/lib/one/ai-selection-vault", () => ({
  recordSelectedAiProvider: mocks.record,
}));

const CAPABLE = {
  hostingMode: "byoc",
  state: "active",
  aiSelection: { version: 1, providers: ["gemini", "openai"] },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const OPENAI = {
  provider: "openai",
  model: null,
  apiKey: "sk-fixture",
  transport: null,
  vertexProject: null,
  vertexLocation: null,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-1");
  mocks.record.mockResolvedValue(undefined);
});

describe("ai-selection agent client", () => {
  it("checks the admitted cloud default when the hub heartbeat advert is missing", async () => {
    mocks.status.mockResolvedValue({ hostingMode: "byoc", state: "active", deploymentTarget: "user_azure", aiSelection: null });
    mocks.pod.mockResolvedValueOnce(json({ status: "cleared", defaultProvider: "azure_openai", defaultModel: "owner-deployment", checkedAtMs: 1 }));
    expect(await verifyAgentCloudAi()).toEqual({ ok: true, provider: "azure_openai", model: "owner-deployment", checkedAtMs: 1 });
    mocks.pod.mockResolvedValueOnce(json({}, 404));
    expect(await verifyAgentCloudAi()).toEqual({ ok: false, code: "PROVIDER_UNSUPPORTED" });
    mocks.pod.mockClear();
    mocks.status.mockResolvedValueOnce({ hostingMode: "shared", state: "active" });
    expect(await verifyAgentCloudAi()).toEqual({ ok: false, code: "AGENT_UNREACHABLE" });
    expect(mocks.pod).not.toHaveBeenCalled();
    mocks.status.mockResolvedValueOnce({ hostingMode: "byoc", state: "active", deploymentTarget: "unknown" });
    expect(await verifyAgentCloudAi()).toEqual({ ok: false, code: "AGENT_UNREACHABLE" });
    expect(mocks.pod).not.toHaveBeenCalled();
  });
  it("retains cloud quota refusal and refuses a provider-mismatched success", async () => {
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("fixture-owner");
    mocks.status.mockResolvedValue({ ...CAPABLE, deploymentTarget: "user_azure",
      aiSelection: { ...CAPABLE.aiSelection, defaultVerification: true } });
    mocks.pod.mockResolvedValueOnce(json({ detail: { code: "QUOTA_EXCEEDED" } }, 422));
    expect(await verifyAgentCloudAi()).toEqual({ ok: false, code: "QUOTA_EXCEEDED" });
    mocks.pod.mockResolvedValueOnce(json({ status: "cleared", defaultProvider: "gemini",
      defaultModel: "fixture", checkedAtMs: 1 }));
    expect(await verifyAgentCloudAi()).toEqual({ ok: false, code: "AGENT_UNREACHABLE" });
    mocks.pod.mockResolvedValueOnce(json({ status: "cleared", defaultProvider: "azure_openai",
      defaultModel: "fixture", checkedAtMs: 1 }));
    expect(await verifyAgentCloudAi()).toEqual({ ok: true, provider: "azure_openai", model: "fixture", checkedAtMs: 1 });
    mocks.pod.mockClear();
    mocks.status.mockImplementationOnce(async () => {
      publishValidatedAuthSessionOwner("another-owner");
      return CAPABLE;
    });
    expect(await verifyAgentCloudAi()).toEqual({ ok: false, code: "AGENT_UNREACHABLE" });
    expect(mocks.pod).not.toHaveBeenCalled();
  });
  it("reads the C3 capability: no agent, too old (with the offered update), or ready", () => {
    expect(agentAiReadiness({ hostingMode: "shared" }, "openai")).toEqual({
      kind: "no_agent",
    });
    expect(
      agentAiReadiness(
        { hostingMode: "byoc", state: "active", aiSelection: null },
        "openai",
      ),
    ).toEqual({
      kind: "needs_update",
      update: {
        releaseId: null,
        deploymentTarget: null,
        installable: false,
        working: false,
      },
    });
    const older = agentAiReadiness(
      {
        hostingMode: "byoc",
        state: "active",
        deploymentTarget: "user_gcp",
        updateInstallable: true,
        aiSelection: { version: 1, providers: ["gemini"] },
        update: {
          releaseId: "rel_fixture",
          summary: "",
          presentationState: "ready",
        },
      },
      "openai",
    );
    expect(older).toMatchObject({
      kind: "needs_update",
      update: { releaseId: "rel_fixture", installable: true },
    });
    expect(agentAiReadiness(CAPABLE as never, "openai")).toEqual({
      kind: "ready",
    });
  });

  it("maps C2 refusals to stable codes", async () => {
    mocks.pod.mockResolvedValueOnce(
      json({ detail: { code: "AI_SELECTION_RECOVERY_PENDING" } }, 503),
    );
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({
      ok: false,
      code: "AI_SELECTION_RECOVERY_PENDING",
    });
    expect(aiSelectionRefusalMessage("AI_SELECTION_RECOVERY_PENDING", "Azure AI"))
      .toContain("change was saved");
    mocks.pod.mockResolvedValueOnce(
      json({ detail: { code: "KEY_REFUSED" } }, 422),
    );
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({
      ok: false,
      code: "KEY_REFUSED",
    });
    mocks.pod.mockResolvedValueOnce(json({ code: "QUOTA_EXCEEDED" }, 422));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({
      ok: false,
      code: "QUOTA_EXCEEDED",
    });
    mocks.pod.mockResolvedValueOnce(json({ detail: "Not Found" }, 404));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({
      ok: false,
      code: "PROVIDER_UNSUPPORTED",
    });
    mocks.pod.mockRejectedValueOnce(new Error("AGENT_KEY_MISMATCH"));
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({
      ok: false,
      code: "AGENT_KEY_CHANGED",
    });
    mocks.pod.mockResolvedValueOnce(
      json({
        status: "active",
        provider: "openai",
        model: "gpt-fixture",
        checkedAtMs: 5,
      }),
    );
    expect(await sendAiSelectionToAgent(OPENAI)).toEqual({
      ok: true,
      provider: "openai",
      model: "gpt-fixture",
      checkedAtMs: 5,
    });
  });

  it("removing the Gemini key clears only a Gemini selection, never an active OpenAI one", async () => {
    mocks.status.mockResolvedValue(CAPABLE);
    mocks.pod.mockResolvedValueOnce(
      json({
        configured: true,
        provider: "openai",
        model: null,
        checkedAtMs: 1,
        lastFailure: null,
        conditionalClear: true,
      }),
    );
    expect(await clearAgentAiSelectionFor("gemini")).toBe("not_needed");
    expect(mocks.pod).toHaveBeenCalledTimes(1);
    expect(mocks.pod.mock.calls[0][1]).toMatchObject({ method: "GET" });

    mocks.pod.mockReset();
    mocks.pod
      .mockResolvedValueOnce(
        json({
          configured: true,
          provider: "gemini",
          model: null,
          checkedAtMs: 1,
          lastFailure: null,
          selectionRevision: 7,
          conditionalClear: true,
        }),
      )
      .mockResolvedValueOnce(json({ status: "cleared" }));
    expect(await clearAgentAiSelectionFor("gemini")).toBe("cleared");
    expect(mocks.pod.mock.calls[1][0]).toBe("ai-selection/clear-if-current");
    expect(mocks.pod.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({
      expectedProvider: "gemini", expectedSelectionRevision: 7,
    }) });
  });

  it("keeps the key when an older agent lacks conditional clear or the choice changed", async () => {
    mocks.status.mockResolvedValue(CAPABLE);
    mocks.pod.mockResolvedValueOnce(json({ configured: true, provider: "gemini" }));
    expect(await clearAgentAiSelectionFor("gemini")).toBe("failed");
    expect(mocks.pod).toHaveBeenCalledTimes(1);
    for (const status of [404, 409]) {
      mocks.pod.mockClear();
      mocks.pod.mockResolvedValueOnce(json({ configured: true, provider: "gemini", selectionRevision: 7, conditionalClear: true }))
        .mockResolvedValueOnce(json({}, status));
      expect(await clearAgentAiSelectionFor("gemini")).toBe("failed");
      expect(mocks.pod).toHaveBeenCalledTimes(2);
      expect(mocks.pod.mock.calls[1][0]).toBe("ai-selection/clear-if-current");
    }
  });

  it("does not clear a provider when asked to verify the cloud default in the same operation", async () => {
    expect(await clearAgentAiSelectionFor("gemini", true)).toBe("failed");
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.pod).not.toHaveBeenCalled();
  });

  it.each([
    json({ detail: "unavailable" }, 503),
    json({}),
    json({ configured: false, provider: "gemini" }),
    json({ configured: true, provider: "unknown-provider" }),
  ])(
    "keeps the key when the agent's current selection cannot be read",
    async (response) => {
    mocks.status.mockResolvedValue(CAPABLE);
    mocks.pod.mockResolvedValueOnce(response);
    expect(await clearAgentAiSelectionFor("gemini")).toBe("failed");
    expect(mocks.pod).toHaveBeenCalledTimes(1);
    },
  );

  it.each([json({}), json({ status: "active" }), new Response("not json", { status: 200 })])(
    "does not accept an unconfirmed clear response",
    async (response) => {
      mocks.status.mockResolvedValue(CAPABLE);
      mocks.pod
        .mockResolvedValueOnce(json({ configured: true, provider: "gemini", selectionRevision: 7, conditionalClear: true }))
        .mockResolvedValueOnce(response);
      expect(await clearAgentAiSelectionFor("gemini")).toBe("failed");
    },
  );

  it("distinguishes Shared from an unreadable or older private agent", async () => {
    mocks.status.mockRejectedValueOnce(new Error("unavailable"));
    expect(await clearAgentAiSelectionFor("gemini")).toBe("failed");
    mocks.status.mockResolvedValueOnce({ hostingMode: "shared" });
    expect(await clearAgentAiSelectionFor("gemini")).toBe("not_needed");
    mocks.status.mockResolvedValueOnce({ hostingMode: "byoc", state: "active" });
    expect(await clearAgentAiSelectionFor("gemini")).toBe("failed");
    expect(mocks.pod).not.toHaveBeenCalled();
  });

  it.each([
    ["AI_SELECTION_RECOVERY_PENDING", "recovery_pending"],
    ["AI_SELECTION_OUTCOME_UNKNOWN", "outcome_unknown"],
  ])("preserves %s when a clear has no confirmed active outcome", async (code, expected) => {
    mocks.status.mockResolvedValue(CAPABLE);
    mocks.pod
      .mockResolvedValueOnce(json({ configured: true, provider: "gemini", selectionRevision: 7, conditionalClear: true }))
      .mockResolvedValueOnce(json({ detail: { code } }, 503));
    expect(await clearAgentAiSelectionFor("gemini")).toBe(expected);
  });

  it("seals a saved Gemini key only to an agent that takes sealed selections", async () => {
    const input = {
      userId: "owner-1",
      vaultKey: "k",
      vaultOwnerToken: "t",
      credential: "gemini-fixture",
      transport: "developer_api" as const,
      vertexProject: "p",
      vertexLocation: "l",
    };
    mocks.status.mockResolvedValueOnce({
      hostingMode: "byoc",
      state: "active",
    });
    expect(await shareGeminiSelectionWithAgent(input)).toBeNull();
    expect(mocks.pod).not.toHaveBeenCalled();

    mocks.status.mockResolvedValueOnce(CAPABLE);
    mocks.pod.mockResolvedValueOnce(
      json({
        status: "active",
        provider: "gemini",
        model: null,
        checkedAtMs: 1,
      }),
    );
    expect(await shareGeminiSelectionWithAgent(input)).toBeNull();
    expect(JSON.parse(String(mocks.pod.mock.calls[0][1].body))).toEqual({
      provider: "gemini",
      model: null,
      apiKey: "gemini-fixture",
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    });
    expect(mocks.record).toHaveBeenCalledWith(input, "gemini", null, expect.any(Function));
  });
});

it("requires a provider-verified receipt when returning an Azure pod to its default", async () => {
  mocks.status.mockResolvedValue({
    ...CAPABLE,
    deploymentTarget: "user_azure",
    aiSelection: {
      version: 1,
      providers: ["azure_openai"],
      defaultVerification: true,
    },
  });
  mocks.pod.mockResolvedValueOnce(json({ status: "cleared" }));
  expect(await clearAgentAiSelectionFor(null, true)).toBe("failed");
  mocks.pod.mockResolvedValueOnce(
    json({
      status: "cleared",
      defaultProvider: "gemini",
      defaultModel: "fixture",
      checkedAtMs: 1,
    }),
  );
  expect(await clearAgentAiSelectionFor(null, true)).toBe("failed");
  mocks.pod.mockResolvedValueOnce(
    json({
      status: "cleared",
      defaultProvider: "azure_openai",
      defaultModel: "fixture",
      checkedAtMs: 1,
    }),
  );
  expect(await clearAgentAiSelectionFor(null, true)).toBe("cleared");
});

it.each(["clear", "share"])("refuses %s after an owner change during status lookup", async operation => {
  mocks.status.mockImplementationOnce(async () => {
    publishValidatedAuthSessionOwner("other-owner");
    return CAPABLE;
  });
  const result = operation === "clear" ? await clearAgentAiSelectionFor("gemini") : await shareGeminiSelectionWithAgent({
    userId: "owner-1", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token", credential: "synthetic-key",
    transport: "developer_api", vertexProject: null, vertexLocation: null,
  });
  expect(result).toBe(operation === "clear" ? "failed" : "Your account changed. Try again.");
  expect(mocks.pod).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});
