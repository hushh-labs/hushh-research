import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsentCenterView } from "@/components/consent/consent-center-view";
import type { ConsentCenterResponse } from "@/lib/services/consent-center-service";

const mocks = vi.hoisted(() => ({
  getCenter: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("id-token"),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1", getIdToken: mocks.getIdToken },
    loading: false,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
  }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({
    activePersona: "investor",
    riaCapability: null,
  }),
}));

vi.mock("@/components/consent/notification-provider", () => ({
  useConsentNotificationState: () => ({
    deliveryMode: "inbox_only",
    permission: "default",
    canPrompt: false,
    prompt: vi.fn(),
  }),
}));

vi.mock("@/lib/consent", () => ({
  useConsentActions: () => ({
    handleApprove: vi.fn(),
    handleApproveBundle: vi.fn(),
    handleDeny: vi.fn(),
    handleDenyBundle: vi.fn(),
    handleRevoke: vi.fn(),
  }),
}));

vi.mock("@/lib/services/cache-service", () => ({
  CACHE_KEYS: {
    CONSENT_CENTER: (...parts: unknown[]) => `center:${parts.join(":")}`,
  },
  CacheService: {
    getInstance: () => ({
      peek: vi.fn(() => null),
    }),
  },
}));

vi.mock("@/lib/services/consent-center-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/consent-center-service")>();

  return {
    ...actual,
    ConsentCenterService: {
      getCenter: mocks.getCenter,
      disconnectRelationship: vi.fn(),
    },
  };
});

function emptyConsentCenter(): ConsentCenterResponse {
  return {
    user_id: "user-1",
    persona_state: {
      user_id: "user-1",
      personas: ["investor"],
      last_active_persona: "investor",
      active_persona: "investor",
      primary_nav_persona: "investor",
      ria_setup_available: false,
      ria_switch_available: false,
      investor_marketplace_opt_in: false,
      iam_schema_ready: true,
      mode: "full",
    },
    ria_onboarding: null,
    summary: {
      incoming_requests: 0,
      outgoing_requests: 0,
      active_grants: 0,
      invites: 0,
      history: 0,
      developer_requests: 0,
      ria_roster: {
        total: 0,
        approved: 0,
        pending: 0,
        invited: 0,
      },
    },
    incoming_requests: [],
    outgoing_requests: [],
    active_grants: [],
    history: [],
    invites: [],
    developer_requests: [],
    requestor_groups: {
      pending: [],
      active: [],
      previous: [],
    },
    self_activity_summary: null,
  };
}

describe("ConsentCenterView", () => {
  it("renders active grants empty copy", async () => {
    mocks.getCenter.mockResolvedValue(emptyConsentCenter());

    render(<ConsentCenterView embedded initialView="active" />);

    expect(await screen.findByText("No active access grants yet.")).toBeTruthy();
  });
});
