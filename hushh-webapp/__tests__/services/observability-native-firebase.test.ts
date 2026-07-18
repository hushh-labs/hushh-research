import { beforeEach, describe, expect, it, vi } from "vitest";

const logEventMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
  },
}));

vi.mock("@capacitor-firebase/analytics", () => ({
  FirebaseAnalytics: {
    logEvent: logEventMock,
  },
}));

import { nativeFirebaseAdapter } from "@/lib/observability/adapters/native-firebase";

describe("native Firebase analytics adapter", () => {
  beforeEach(() => {
    logEventMock.mockReset();
  });

  it("forwards metadata-only events to the Capacitor Firebase analytics plugin", async () => {
    await nativeFirebaseAdapter.track("growth_funnel_step_completed", {
      env: "uat",
      platform: "ios",
      event_category: "funnel",
      journey: "ria",
      step: "workspace_ready",
      app_version: "2.1.0",
      workspace_source: "ria_client_workspace",
      bool_flag: true,
      nullable_field: null,
    });

    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith({
      name: "growth_funnel_step_completed",
      params: {
        env: "uat",
        platform: "ios",
        event_category: "funnel",
        journey: "ria",
        step: "workspace_ready",
        app_version: "2.1.0",
        workspace_source: "ria_client_workspace",
        bool_flag: "true",
      },
    });
  });

  it("ignores inherited metadata before forwarding native Firebase params", async () => {
    const payload = Object.create({
      user_id: "inherited-user",
      email: "inherited@example.com",
    }) as Record<string, string | number | boolean | null>;

    payload.env = "uat";
    payload.event_category = "system";
    payload.blocking_loader_shown = true;

    await nativeFirebaseAdapter.track("growth_funnel_step_completed", payload);

    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith({
      name: "growth_funnel_step_completed",
      params: {
        env: "uat",
        event_category: "system",
        blocking_loader_shown: "true",
      },
    });
  });
});
