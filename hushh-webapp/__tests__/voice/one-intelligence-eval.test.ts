import { describe, expect, it } from "vitest";

import { planOneGoal } from "@/lib/one-goal/one-goal-planner";
import { classifyOneVoicePkmMemoryCandidate } from "@/lib/voice/one-voice-live-action-bridge";

type EvalCase =
  | {
      kind: "goal";
      transcript: string;
      candidateActionId?: string;
      slots?: Record<string, unknown>;
      expectedStatus: "ready" | "input_needed" | "blocked";
      expectedActionId?: string;
      expectedSymbol?: string;
      expectedPickSource?: string;
    }
  | {
      kind: "memory";
      transcript: string;
      expectedCandidate: boolean;
      expectedExplicit: boolean;
    };

const EVAL_CASES: EvalCase[] = [
  { kind: "goal", transcript: "Analyze TSLA", expectedStatus: "input_needed", expectedActionId: "analysis.start", expectedSymbol: "TSLA" },
  { kind: "goal", transcript: "Analyze TSLA using default", expectedStatus: "ready", expectedActionId: "analysis.start", expectedSymbol: "TSLA", expectedPickSource: "default" },
  { kind: "goal", transcript: "analyzing nvidia using default", expectedStatus: "ready", expectedActionId: "analysis.start", expectedSymbol: "NVDA", expectedPickSource: "default" },
  { kind: "goal", transcript: "start the debate for Microsoft with the default list", candidateActionId: "analysis.start", slots: { symbol: "MSFT", pickSource: "default" }, expectedStatus: "ready", expectedActionId: "analysis.start", expectedSymbol: "MSFT", expectedPickSource: "default" },
  { kind: "goal", transcript: "start the debate for Tesla", candidateActionId: "analysis.start", slots: { symbol: "TSLA" }, expectedStatus: "input_needed", expectedActionId: "analysis.start", expectedSymbol: "TSLA" },
  { kind: "goal", transcript: "use default for the pending stock debate", candidateActionId: "analysis.start", slots: { pickSource: "default" }, expectedStatus: "input_needed", expectedActionId: "analysis.start", expectedPickSource: "default" },
  { kind: "goal", transcript: "open analysis", candidateActionId: "route.kai_analysis", expectedStatus: "ready", expectedActionId: "route.kai_analysis" },
  { kind: "goal", transcript: "show analysis history", candidateActionId: "route.analysis_history", expectedStatus: "ready", expectedActionId: "route.analysis_history" },
  { kind: "goal", transcript: "resume active analysis", candidateActionId: "analysis.resume_active", expectedStatus: "ready", expectedActionId: "analysis.resume_active" },
  { kind: "goal", transcript: "cancel the active analysis", candidateActionId: "analysis.cancel_active", expectedStatus: "ready", expectedActionId: "analysis.cancel_active" },
  { kind: "goal", transcript: "open agents", candidateActionId: "route.one_agents", expectedStatus: "ready", expectedActionId: "route.one_agents" },
  { kind: "goal", transcript: "go to marketplace", candidateActionId: "route.one_marketplace", expectedStatus: "ready", expectedActionId: "route.one_marketplace" },
  { kind: "goal", transcript: "open saved knowledge", candidateActionId: "route.one_pkm", expectedStatus: "ready", expectedActionId: "route.one_pkm" },
  { kind: "goal", transcript: "What needs a reply today?", expectedStatus: "ready", expectedActionId: "email.chat.turn" },
  { kind: "goal", transcript: "Who can see me right now?", expectedStatus: "ready", expectedActionId: "location.chat.turn" },
  { kind: "goal", transcript: "Start sharing my location with Rohan", expectedStatus: "ready", expectedActionId: "location.chat.turn" },
  { kind: "goal", transcript: "Add Kushal to my trusted connections", expectedStatus: "ready", expectedActionId: "connections.chat.turn" },
  { kind: "goal", transcript: "how many subscription i have put available on marketplace?", expectedStatus: "ready", expectedActionId: "marketplace.information.chat.turn" },
  { kind: "goal", transcript: "can you approve any pending request for information marketplace?", expectedStatus: "ready", expectedActionId: "marketplace.information.requests.turn" },
  { kind: "goal", transcript: "open my profile", candidateActionId: "route.profile", expectedStatus: "ready", expectedActionId: "route.profile" },
  { kind: "goal", transcript: "open gmail settings", candidateActionId: "route.profile_gmail_panel", expectedStatus: "ready", expectedActionId: "route.profile_gmail_panel" },
  { kind: "goal", transcript: "show connected systems", candidateActionId: "route.profile_connected_systems", expectedStatus: "ready", expectedActionId: "route.profile_connected_systems" },
  { kind: "goal", transcript: "open security settings", candidateActionId: "route.profile_security_panel", expectedStatus: "ready", expectedActionId: "route.profile_security_panel" },
  { kind: "goal", transcript: "open memory lab", candidateActionId: "route.profile_pkm_agent_lab", expectedStatus: "ready", expectedActionId: "route.profile_pkm_agent_lab" },
  { kind: "goal", transcript: "review this before saving to personal data", candidateActionId: "profile.pkm.preview_capture", expectedStatus: "ready", expectedActionId: "profile.pkm.preview_capture" },
  { kind: "goal", transcript: "save the reviewed memory", candidateActionId: "profile.pkm.save_capture", expectedStatus: "ready", expectedActionId: "profile.pkm.save_capture" },
  { kind: "goal", transcript: "preview receipts memory", candidateActionId: "profile.receipts_memory.preview", expectedStatus: "ready", expectedActionId: "profile.receipts_memory.preview" },
  { kind: "goal", transcript: "save receipts memory", candidateActionId: "profile.receipts_memory.save", expectedStatus: "ready", expectedActionId: "profile.receipts_memory.save" },
  { kind: "goal", transcript: "connect gmail", candidateActionId: "profile.gmail.connect", expectedStatus: "ready", expectedActionId: "profile.gmail.connect" },
  { kind: "goal", transcript: "sync gmail now", candidateActionId: "profile.gmail.sync_now", expectedStatus: "ready", expectedActionId: "profile.gmail.sync_now" },
  { kind: "goal", transcript: "open email helper", candidateActionId: "route.one_kyc", expectedStatus: "ready", expectedActionId: "route.one_kyc" },
  { kind: "goal", transcript: "manage aliases", candidateActionId: "kyc.aliases.manage", expectedStatus: "ready", expectedActionId: "kyc.aliases.manage" },
  { kind: "goal", transcript: "open consent center", candidateActionId: "route.consents", expectedStatus: "ready", expectedActionId: "route.consents" },
  { kind: "goal", transcript: "go to finance home", candidateActionId: "route.kai_home", expectedStatus: "ready", expectedActionId: "route.kai_home" },
  { kind: "goal", transcript: "open portfolio dashboard", candidateActionId: "route.kai_dashboard", expectedStatus: "ready", expectedActionId: "route.kai_dashboard" },
  { kind: "goal", transcript: "open portfolio import", candidateActionId: "route.kai_import", expectedStatus: "ready", expectedActionId: "route.kai_import" },
  { kind: "goal", transcript: "open investments", candidateActionId: "route.kai_investments", expectedStatus: "ready", expectedActionId: "route.kai_investments" },
  { kind: "goal", transcript: "open optimize", candidateActionId: "route.kai_optimize", expectedStatus: "ready", expectedActionId: "route.kai_optimize" },
  { kind: "goal", transcript: "open RIA home", candidateActionId: "route.ria_home", expectedStatus: "ready", expectedActionId: "route.ria_home" },
  { kind: "goal", transcript: "open RIA clients", candidateActionId: "route.ria_clients", expectedStatus: "ready", expectedActionId: "route.ria_clients" },
  { kind: "goal", transcript: "open RIA picks", candidateActionId: "route.ria_picks", expectedStatus: "ready", expectedActionId: "route.ria_picks" },
  { kind: "goal", transcript: "switch picks to Kai source", candidateActionId: "ria.picks.open_source_kai", expectedStatus: "ready", expectedActionId: "ria.picks.open_source_kai" },
  { kind: "goal", transcript: "switch picks to my source", candidateActionId: "ria.picks.open_source_my", expectedStatus: "ready", expectedActionId: "ria.picks.open_source_my" },
  { kind: "goal", transcript: "open RIA workspace overview", candidateActionId: "ria.client_workspace.open_overview_tab", expectedStatus: "ready", expectedActionId: "ria.client_workspace.open_overview_tab" },
  { kind: "memory", transcript: "remember that I prefer concise summaries", expectedCandidate: true, expectedExplicit: true },
  { kind: "memory", transcript: "I usually use the default list for stock debates", expectedCandidate: true, expectedExplicit: false },
  { kind: "memory", transcript: "my default answer style is short and direct", expectedCandidate: true, expectedExplicit: false },
  { kind: "memory", transcript: "call me Kushal", expectedCandidate: true, expectedExplicit: false },
  { kind: "memory", transcript: "save that I like weekly portfolio summaries to memory", expectedCandidate: true, expectedExplicit: true },
  { kind: "memory", transcript: "what lists are available", expectedCandidate: false, expectedExplicit: false },
  { kind: "memory", transcript: "tell me about TSLA", expectedCandidate: false, expectedExplicit: false },
  { kind: "memory", transcript: "my password is hunter2", expectedCandidate: false, expectedExplicit: false },
  { kind: "memory", transcript: "my api key is REDACTED_TEST_KEY", expectedCandidate: false, expectedExplicit: false },
  { kind: "memory", transcript: "remember token abcdefghijklmnopqrstuvwxyz1234", expectedCandidate: false, expectedExplicit: false },
  { kind: "memory", transcript: "I prefer concise answers?", expectedCandidate: false, expectedExplicit: false },
  { kind: "memory", transcript: "save this to personal data", expectedCandidate: true, expectedExplicit: true },
];

describe("One Intelligence contract eval", () => {
  it.each(EVAL_CASES)("$kind: $transcript", (testCase) => {
    if (testCase.kind === "memory") {
      expect(classifyOneVoicePkmMemoryCandidate(testCase.transcript)).toMatchObject({
        candidate: testCase.expectedCandidate,
        explicit: testCase.expectedExplicit,
      });
      return;
    }

    const plan = planOneGoal({
      transcript: testCase.transcript,
      candidateActionId: testCase.candidateActionId,
      slots: testCase.slots,
      entrypoint: "voice",
    });

    expect(plan.status).toBe(testCase.expectedStatus);
    if (plan.status === "blocked") return;
    expect(plan.action.action_id).toBe(testCase.expectedActionId);
    if (testCase.expectedSymbol) {
      expect(plan.slots.symbol).toBe(testCase.expectedSymbol);
    }
    if (testCase.expectedPickSource) {
      expect(plan.slots.pickSource).toBe(testCase.expectedPickSource);
    }
  });
});
