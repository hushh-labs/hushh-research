import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";

export type MorphyAxDisposition =
  | "execute_visible_action"
  | "confirm_visible_action"
  | "answer_current_page"
  | "answer_conversationally"
  | "ask_clarifying_question"
  | "provide_input"
  | "recover";

export type MorphyAxAssessmentSource = "one" | "agent_onboarding";

/** A semantic assessment produced by intelligence, never by lexical matching. */
export type MorphyAxAssessmentV1 = {
  schema_version: "morphy_ax_assessment.v1";
  source: MorphyAxAssessmentSource;
  disposition: MorphyAxDisposition;
  candidate_action_id: string | null;
  missing_input: string | null;
  ambiguous: boolean;
  confidence: number;
  expected_outcome:
    "action" | "confirmation" | "conversation" | "clarification";
};

export type MorphyAxSnapshotV1 = {
  schema_version: "morphy_ax_snapshot.v1";
  snapshot_id: string;
  revisions: OneVoiceContextSnapshot["revisions"];
  access: {
    signed_in: boolean;
    vault_ready: boolean;
    persona: string;
  };
  context: {
    screen: string;
    route_family: string;
    playbook_id: string;
    visible_modules: string[];
    visible_control_ids: string[];
    onboarding: OneVoiceContextSnapshot["onboarding"];
  };
  tools: {
    available_action_ids: string[];
  };
  orchestration: {
    pending_settlement: boolean;
    voice: OneVoiceContextSnapshot["voice"];
    busy_operations: string[];
  };
  privacy: {
    redacted: true;
    excludes: string[];
  };
};

export type MorphyAxPresentationState =
  | "idle"
  | "orienting"
  | "listening"
  | "understanding"
  | "confirming"
  | "acting"
  | "settling"
  | "responding"
  | "recovering";

export type MorphyAxAssessmentDecision =
  | { status: "permitted"; action_id: string }
  | { status: "confirmation_required"; action_id: string }
  | { status: "conversation"; disposition: MorphyAxDisposition }
  | { status: "clarify"; reason: string }
  | { status: "rejected"; reason: string };
