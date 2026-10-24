import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({ error: vi.fn(), verify: vi.fn(), store: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/one/profile/ai" }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: mocks.error, success: vi.fn() } }));
vi.mock("@/lib/connections/use-ai-placement", () => ({ useAiPlacement: () => ({ placement: "azure", refreshPlacement: vi.fn() }) }));
vi.mock("@/lib/one/ai-selection-agent", async (original) => ({
  ...await original<typeof import("@/lib/one/ai-selection-agent")>(),
  verifyAgentCloudAi: mocks.verify,
}));
vi.mock("@/lib/services/personal-knowledge-model-service", async (original) => ({
  ...await original<typeof import("@/lib/services/personal-knowledge-model-service")>(),
  PersonalKnowledgeModelService: { loadRuntimeSecret: vi.fn().mockResolvedValue(null), storeRuntimeSecret: mocks.store },
}));

beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-fixture");
  mocks.verify.mockResolvedValue({ ok: false, code: "PROVIDER_UNSUPPORTED" });
});

it("shows the cloud update refusal and preserves the working selection without saving", async () => {
  render(<GeminiRuntimeSettingsCard
    userId="owner-fixture" needsVaultCreation={false} needsUnlock
    onRequestVaultUnlock={vi.fn()} onRequestVaultCreation={vi.fn()}
  />);
  const choice = await screen.findByRole("button", { name: /Use existing cloud/ });
  await act(async () => { fireEvent.click(choice); });
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Your agent needs an update to use Azure AI."));
  expect(choice).toHaveAttribute("aria-pressed", "true");
  expect(mocks.verify).toHaveBeenCalledOnce();
  expect(mocks.store).not.toHaveBeenCalled();
});
