// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "reviewer" }, userId: "reviewer", loading: false }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    vaultKey: "test-vault-key",
    vaultOwnerToken: "test-owner-token",
  }),
}));

import {
  AgentTurnStreamPanel,
  agentToolEventToVisibleStreamEvent,
} from "@/components/agent/agent-turn-stream-panel";
import {
  GOOGLE_APPS_CLEARANCE_NOTE,
  isProductionProfileLegalSubsurface,
  isProductionVoiceBarSuppressedRoute,
  turnInvolvesGoogleApps,
} from "@/lib/agent/production-visitor-posture";
import type { AgentChatToolEvent } from "@/lib/services/agent-chat-client";

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeMailStep() {
  const toolEvent: AgentChatToolEvent = {
    callId: "prod-mail",
    actionId: null,
    label: "Gmail",
    execution: "server",
    raw: { protocol: "ag-ui", toolName: "ask_email_agent" },
  };
  return agentToolEventToVisibleStreamEvent("result", toolEvent, 1);
}

describe("production visitor posture", () => {
  it("shows the concise Google Apps clearance note only on finished Production Google turns", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    const mailStep = makeMailStep();

    const view = render(
      <AgentTurnStreamPanel
        streamEvents={[mailStep]}
        responseText="Checking Gmail…"
        isStreaming
      />,
    );
    expect(screen.queryByTestId("agui-google-clearance-note")).not.toBeInTheDocument();

    view.rerender(
      <AgentTurnStreamPanel
        streamEvents={[mailStep]}
        responseText="Connect Gmail to continue."
        isStreaming={false}
      />,
    );
    expect(screen.getByTestId("agui-google-clearance-note")).toHaveTextContent(
      GOOGLE_APPS_CLEARANCE_NOTE,
    );

    view.rerender(
      <AgentTurnStreamPanel
        sources={[{ agentId: "agent_email", label: "Mail", reason: "Read inbox" }]}
        responseText="Here are your latest threads."
        isStreaming={false}
      />,
    );
    expect(screen.getByTestId("agui-google-clearance-note")).toHaveTextContent(
      GOOGLE_APPS_CLEARANCE_NOTE,
    );

    view.rerender(
      <AgentTurnStreamPanel
        streamEvents={[]}
        responseText="It is 52 °F and partly sunny in Kirkland."
        isStreaming={false}
      />,
    );
    expect(screen.queryByTestId("agui-google-clearance-note")).not.toBeInTheDocument();

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    view.rerender(
      <AgentTurnStreamPanel
        streamEvents={[mailStep]}
        responseText="Connect Gmail to continue."
        isStreaming={false}
      />,
    );
    expect(screen.queryByTestId("agui-google-clearance-note")).not.toBeInTheDocument();
  });

  it("detects Google Apps turns across brands, specialist sources, structured cards, and prose", () => {
    expect(turnInvolvesGoogleApps({ streamEvents: [{ brand: "drive" }] })).toBe(true);
    expect(turnInvolvesGoogleApps({ sources: [{ agentId: "agent_calendar" }] })).toBe(true);
    expect(
      turnInvolvesGoogleApps({
        structuredExperiences: [{ type: "one.connector_read.v1", connector: "gmail" }],
      }),
    ).toBe(true);
    expect(
      turnInvolvesGoogleApps({
        responseText: "You can link Google Calendar from Connectors.",
      }),
    ).toBe(true);
    expect(
      turnInvolvesGoogleApps({
        streamEvents: [{ brand: "notion" }],
        responseText: "Checked your Notion workspace.",
      }),
    ).toBe(false);
  });

  it("suppresses the bottom voice bar on Production research, blog, early setup, and legal routes only", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    for (const pathname of [
      "/research",
      "/research/protocol",
      "/blog",
      "/blog/consent-first-ai",
      "/welcome",
      "/terms",
      "/privacy",
      "/one/profile/regulatory",
      "/getting-started",
      "/one/welcome",
      "/one/setup/vault",
      "/ria/onboarding",
    ]) {
      expect(
        isProductionVoiceBarSuppressedRoute({
          pathname,
          shellPathname: pathname,
          isAuthenticated: true,
          useOnboardingChrome: false,
        }),
      ).toBe(true);
    }

    expect(
      isProductionVoiceBarSuppressedRoute({
        pathname: "/one/feed",
        shellPathname: "/one/feed",
        isAuthenticated: true,
        useOnboardingChrome: false,
      }),
    ).toBe(false);

    expect(
      isProductionVoiceBarSuppressedRoute({
        pathname: "/",
        shellPathname: "/",
        isAuthenticated: false,
        useOnboardingChrome: false,
      }),
    ).toBe(true);

    expect(
      isProductionProfileLegalSubsurface(
        "/one/profile",
        new URLSearchParams("panel=legal"),
      ),
    ).toBe(true);
    expect(
      isProductionProfileLegalSubsurface(
        "/one/feed",
        new URLSearchParams("profile_detail=terms"),
      ),
    ).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(
      isProductionVoiceBarSuppressedRoute({
        pathname: "/terms",
        shellPathname: "/terms",
        isAuthenticated: true,
        useOnboardingChrome: false,
      }),
    ).toBe(false);
  });
});
