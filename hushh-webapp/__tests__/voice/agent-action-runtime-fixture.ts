import { ROUTES } from "@/lib/navigation/routes";
import type { AppRuntimeState } from "@/lib/kai/actions/voice-types";

export function runtimeState(
  overrides: Partial<AppRuntimeState> = {},
): AppRuntimeState {
  return {
    auth: {
      signed_in: true,
      user_id: "user_1",
    },
    vault: {
      unlocked: true,
      token_available: true,
      token_valid: true,
    },
    route: {
      pathname: ROUTES.HOME,
      screen: "chat",
      subview: null,
    },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: {
      has_portfolio_data: true,
    },
    persona: {
      active: "investor",
      primary_nav: "investor",
      available: ["investor"],
      transition_target: null,
      ria_switch_available: false,
      ria_setup_available: false,
    },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
    ...overrides,
  };
}
