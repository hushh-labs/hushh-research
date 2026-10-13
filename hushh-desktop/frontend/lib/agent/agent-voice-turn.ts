import {
  shouldConfirmAgentVoiceTranscript,
  type AgentVoiceTranscriptionResult,
} from "@/lib/services/agent-voice-client";

export type AgentVoiceTurnRunner = (text: string, options: { source: "voice" }) => Promise<void>;

export async function handleAgentVoiceTranscriptTurn(input: {
  result: AgentVoiceTranscriptionResult;
  runTurn: AgentVoiceTurnRunner;
  requestReview: (transcript: string, reason: string | null) => void;
}): Promise<void> {
  if (shouldConfirmAgentVoiceTranscript(input.result)) {
    input.requestReview(input.result.transcript, input.result.reason);
    return;
  }

  await input.runTurn(input.result.transcript, { source: "voice" });
}
