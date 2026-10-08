// @vitest-environment node
//
// An agent whose own model is the person's Azure deployment (or a sealed OpenAI
// key) refuses private commands with a typed 503 COMMAND_MODEL_UNAVAILABLE. That
// refusal is standing, so it must never read as the generic 5xx "try again
// shortly", which would send the person back to retry something that cannot work.
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  ownerPodRequest: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mocks.apiFetch,
    ownerPodRequest: mocks.ownerPodRequest,
  },
}));
vi.mock("@/lib/voice/kai-action-gateway", () => ({
  getKaiActionById: vi.fn(),
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getPermissionState: vi.fn(),
    requestLocationPermission: vi.fn(),
  },
}));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  prepareLocalOnboardingAction: vi.fn(),
  canonicalActionBinding: JSON.stringify,
}));
import {
  LocationCommandRuntime,
  type CommandPorts,
} from "@/lib/agent/location-command-runtime";

const STANDING =
  "Voice and location commands need a Gemini model, so they are not available with your current AI model yet.";
const TEMPORARY =
  "The command service is temporarily unavailable. Try again shortly.";

function runtime(): LocationCommandRuntime {
  const ports: CommandPorts = {
    authority: () => ({ userId: "owner", token: "pod-session", vaultKey: "k" }),
    context: () => ({}),
    execute: vi.fn(),
    navigate: vi.fn(),
    present: vi.fn(),
  };
  return new LocationCommandRuntime(ports);
}

function podRefuses(detail: Record<string, unknown>): void {
  mocks.ownerPodRequest.mockResolvedValue(
    new Response(JSON.stringify({ detail }), { status: 503 }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([
  ["the owner's Azure model", "user_azure_mi"],
  ["a sealed OpenAI key", "byok"],
])(
  "says plainly that commands are not available on %s",
  async (_label, runtimeMode) => {
    podRefuses({ code: "COMMAND_MODEL_UNAVAILABLE", runtimeMode });

    const refused = runtime().transcribe("synthetic-audio");

    await expect(refused).rejects.toMatchObject({
      message: STANDING,
      status: 503,
      code: "COMMAND_MODEL_UNAVAILABLE",
    });
    expect(mocks.ownerPodRequest).toHaveBeenCalledWith(
      "commands/transcriptions",
      expect.anything(),
    );
  },
);

it("keeps a genuinely transient provider failure as try-again (negative control)", async () => {
  podRefuses({ code: "COMMAND_PROVIDER_UNAVAILABLE" });

  await expect(runtime().transcribe("synthetic-audio")).rejects.toMatchObject({
    message: TEMPORARY,
    status: 503,
    code: "COMMAND_PROVIDER_UNAVAILABLE",
  });
});

it("never claims the standing refusal for an untyped 503", async () => {
  mocks.ownerPodRequest.mockResolvedValue(
    new Response("not json", { status: 503 }),
  );

  await expect(runtime().transcribe("synthetic-audio")).rejects.toMatchObject({
    message: TEMPORARY,
    code: "COMMAND_UNAVAILABLE",
  });
});
