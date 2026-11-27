import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { ApiService } from "@/lib/services/api-service";
import {
  DEFAULT_POD_BACKGROUND_CONFIG,
  parsePodBackgroundConfig,
  readPodBackgroundConfig,
  setConnectorBackgroundPrep,
  setPodSessionOnlyLockdown,
} from "@/lib/services/pod-background-config";
import { PodSessionLockdownControl } from "@/components/connections/pod-session-lockdown-row";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    ownerPodRequest: vi.fn(),
  },
}));

vi.mock("@/lib/morphy-ux/morphy", async (original) => ({
  ...(await original<object>()),
  morphyToast: { error: vi.fn(), success: vi.fn() },
}));

describe("Stage 2a pod-background-config & Session-only lockdown UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner-1");
  });

  it("defaults all per-connector background prep toggles ON and lockdown OFF", () => {
    expect(parsePodBackgroundConfig({})).toEqual(DEFAULT_POD_BACKGROUND_CONFIG);
    expect(
      parsePodBackgroundConfig({
        config: {
          session_only_lockdown: true,
          background_prep_gmail: false,
          background_daily_wake_cap: 12,
        },
      }),
    ).toEqual({
      sessionOnlyLockdown: true,
      backgroundPrepEnabled: true,
      connectors: {
        gmail: false,
        calendar: true,
        drive: true,
        contacts: true,
        mcp: true,
      },
      dailyWakeCap: 12,
    });
  });

  it("reads status and writes per-connector and lockdown updates via ownerPodRequest", async () => {
    vi.mocked(ApiService.ownerPodRequest)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            hushhId: "ha1_test",
            config: {
              session_only_lockdown: false,
              background_prep_gmail: true,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              session_only_lockdown: false,
              background_prep_gmail: false,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              session_only_lockdown: true,
              background_prep_gmail: false,
            },
          }),
          { status: 200 },
        ),
      );

    const initial = await readPodBackgroundConfig();
    expect(initial?.connectors.gmail).toBe(true);
    expect(initial?.sessionOnlyLockdown).toBe(false);

    const updatedConnector = await setConnectorBackgroundPrep("gmail", false);
    expect(updatedConnector.connectors.gmail).toBe(false);
    expect(ApiService.ownerPodRequest).toHaveBeenNthCalledWith(
      2,
      "config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ changes: { background_prep_gmail: false } }),
      }),
      false,
      undefined,
      undefined,
      undefined,
    );

    const locked = await setPodSessionOnlyLockdown(true);
    expect(locked.sessionOnlyLockdown).toBe(true);
  });

  it("renders PodSessionLockdownControl and toggles session_only_lockdown", async () => {
    vi.mocked(ApiService.ownerPodRequest)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { session_only_lockdown: false },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { session_only_lockdown: true },
          }),
          { status: 200 },
        ),
      );

    render(<PodSessionLockdownControl />);
    const control = await screen.findByTestId("pod-session-only-lockdown");
    expect(control).toHaveTextContent(
      "Off · One quietly prepares drafts and memory updates while you are away.",
    );

    const toggle = screen.getByRole("switch", { name: "Session-only lockdown" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(control).toHaveTextContent("Paused · One runs only while your app is open.");
    });
  });
});
