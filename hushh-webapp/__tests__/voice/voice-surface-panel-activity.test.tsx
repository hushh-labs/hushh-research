import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildOneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import { VoiceSurfaceActivityBoundary } from "@/lib/voice/voice-surface-activity";
import {
  clearVoiceSurfaceMetadata,
  getVoiceSurfaceMetadata,
  publishVoiceSurfaceMetadata,
  usePublishVoiceSurfaceMetadata,
  type VoiceSurfaceMetadata,
} from "@/lib/voice/voice-surface-metadata";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

const PUBLISHERS = ["market_panel", "portfolio_panel", "analysis_panel"];

function runtime(
  pathname = "/one/kai?tab=analysis",
  screen = "kai_analysis",
): AppRuntimeState {
  return {
    auth: { signed_in: true, user_id: "user_1" },
    vault: { unlocked: true, token_available: true, token_valid: true },
    route: { pathname, screen, subview: "analysis" },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: { has_portfolio_data: true },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
  };
}

/** The inventory the Analysis panel publishes on `/one/kai?tab=analysis`. */
const ANALYSIS_SURFACE: VoiceSurfaceMetadata = {
  screenId: "kai_analysis_history",
  title: "Analysis",
  actions: [
    {
      id: "analysis.start",
      actionId: "analysis.start",
      label: "Start stock analysis",
      purpose: null,
      description: null,
      voiceAliases: [],
    },
  ],
};

/** The inventory the Market panel republishes on every live price tick. */
const MARKET_SURFACE: VoiceSurfaceMetadata = {
  screenId: "kai_market_preview",
  title: "Market",
  actions: [
    {
      id: "market.open_watchlist",
      actionId: "market.open_watchlist",
      label: "Open watchlist",
      purpose: null,
      description: null,
      voiceAliases: [],
    },
  ],
};

function Panel({ metadata }: { metadata: VoiceSurfaceMetadata }) {
  usePublishVoiceSurfaceMetadata(metadata);
  return null;
}

afterEach(() => {
  PUBLISHERS.forEach(clearVoiceSurfaceMetadata);
});

describe("voice surface panel activity", () => {
  it("keeps a backgrounded pager panel out of the route-publisher race", () => {
    // Analysis mounts first; Market republishes after it on a price tick. The
    // store resolves identity from the LAST route publisher, so without the
    // activity boundary Market would own the screen while the person is
    // looking at Analysis.
    render(
      <>
        <VoiceSurfaceActivityBoundary active>
          <Panel metadata={ANALYSIS_SURFACE} />
        </VoiceSurfaceActivityBoundary>
        <VoiceSurfaceActivityBoundary active={false}>
          <Panel metadata={MARKET_SURFACE} />
        </VoiceSurfaceActivityBoundary>
      </>,
    );

    const published = getVoiceSurfaceMetadata();
    expect(published?.screenId).toBe("kai_analysis_history");
    expect(published?.actions.map((action) => action.actionId)).toEqual([
      "analysis.start",
    ]);
  });

  it("composes activity down a nested pager", () => {
    render(
      <VoiceSurfaceActivityBoundary active={false}>
        <VoiceSurfaceActivityBoundary active>
          <Panel metadata={MARKET_SURFACE} />
        </VoiceSurfaceActivityBoundary>
      </VoiceSurfaceActivityBoundary>,
    );

    expect(getVoiceSurfaceMetadata()).toBeNull();
  });

  it("does not let a null-metadata route publisher blank an active surface", () => {
    publishVoiceSurfaceMetadata("analysis_panel", ANALYSIS_SURFACE, {
      role: "route",
      routeKey: "/one/kai",
    });
    publishVoiceSurfaceMetadata("market_panel", null, {
      role: "route",
      routeKey: "/one/kai",
    });

    expect(getVoiceSurfaceMetadata()?.screenId).toBe("kai_analysis_history");
  });

  it("carries analysis.start into the snapshot inventory on the Analysis tab", () => {
    // A mounted inventory suppresses the route-contract fallback, so an
    // omission here is what made One refuse "analyse NVDA" on the very screen
    // that runs it.
    publishVoiceSurfaceMetadata("analysis_panel", ANALYSIS_SURFACE, {
      role: "route",
      routeKey: "/one/kai",
    });

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: runtime(),
    });

    expect(snapshot.available_action_ids).toContain("analysis.start");
  });
});
