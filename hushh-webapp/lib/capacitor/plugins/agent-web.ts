/**
 * Hussh Local Agent - Web Implementation
 *
 * DEV: Routes to remote API by default (useRemoteLLM: true).
 * When set to local, uses on-device intent classification and agents.
 */

import type { HushhAgentPlugin, AgentResponse, AgentInfo } from "../index";
import { SettingsService } from "../../services/settings-service";
import {
  resolveLocalIntentAsync,
  type IntentResolution,
  type OneVoiceIntentContext,
} from "../../voice/local-intent-resolver";

const AGENT_IDS = {
  orchestrator: 'agent_orchestrator',
  identity: 'agent_identity',
  shopper: 'agent_shopper',
};

const AGENT_PORTS = {
  agent_orchestrator: 10000,
  agent_identity: 10003,
  agent_shopper: 10004,
};

export class HushhAgentWeb implements HushhAgentPlugin {

  async handleMessage(options: {
    message: string;
    userId: string;
    agentId?: string;
    sessionState?: Record<string, unknown>;
  }): Promise<AgentResponse> {
    const { message, userId, agentId, sessionState } = options;

    // DEV default: use remote API
    const useLocal = await SettingsService.shouldUseLocalAgents();
    if (!useLocal) {
      // Signal to caller to use remote API
      return {
        response: '__USE_REMOTE_API__',
        isComplete: false,
        needsConsent: false,
      };
    }

    // Local mode: use on-device agents
    if (agentId && agentId !== AGENT_IDS.orchestrator) {
      return this.routeToAgent(agentId, message, userId, sessionState || {});
    }

    const context = this.readIntentContext(sessionState || {});
    if (!context) {
      return {
        response: "I need the current Agent One screen context before I can safely interpret that request.",
        isComplete: false,
        needsConsent: false,
      };
    }

    const intent = await resolveLocalIntentAsync({
      utterance: message,
      context,
      catalogVersion: context.catalogVersion,
    });
    return this.responseForIntent(intent);
  }

  async classifyIntent(options: { message: string }): Promise<{
    hasDelegate: boolean;
    targetAgent: string;
    targetPort?: number;
    domain: string;
  }> {
    return this.classifyIntentSync(options.message);
  }

  async getAgentInfo(): Promise<{
    agents: AgentInfo[];
    version: string;
    protocolVersion: string;
  }> {
    return {
      agents: [
        { id: AGENT_IDS.orchestrator, name: 'Orchestrator', port: AGENT_PORTS.agent_orchestrator, available: true },
        { id: AGENT_IDS.identity, name: 'Identity', port: AGENT_PORTS.agent_identity, available: false },
        { id: AGENT_IDS.shopper, name: 'Shopper', port: AGENT_PORTS.agent_shopper, available: false },
      ],
      version: '1.0.0-dev',
      protocolVersion: 'HCT-1.0',
    };
  }

  private classifyIntentSync(_message: string): {
    hasDelegate: boolean;
    targetAgent: string;
    targetPort?: number;
    domain: string;
  } {
    return {
      hasDelegate: false,
      targetAgent: AGENT_IDS.orchestrator,
      domain: 'general',
    };
  }

  private readIntentContext(
    sessionState: Record<string, unknown>,
  ): OneVoiceIntentContext | null {
    const raw = sessionState.oneVoiceContext;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const availableActionIds = value.availableActionIds;
    const contextRevision = value.contextRevision;
    const catalogVersion = value.catalogVersion;
    if (
      !Array.isArray(availableActionIds) ||
      !availableActionIds.every((entry) => typeof entry === "string") ||
      typeof contextRevision !== "string" ||
      !contextRevision.trim() ||
      typeof catalogVersion !== "string" ||
      !catalogVersion.trim()
    ) {
      return null;
    }
    const executableActionIds = value.executableActionIds;
    const redactedState = value.redactedState;
    return {
      contextRevision,
      catalogVersion,
      availableActionIds,
      executableActionIds:
        Array.isArray(executableActionIds) &&
        executableActionIds.every((entry) => typeof entry === "string")
          ? executableActionIds
          : undefined,
      route:
        value.route && typeof value.route === "object" && !Array.isArray(value.route)
          ? (value.route as OneVoiceIntentContext["route"])
          : undefined,
      redactedState:
        redactedState && typeof redactedState === "object" && !Array.isArray(redactedState)
          ? (redactedState as OneVoiceIntentContext["redactedState"])
          : undefined,
    };
  }

  private responseForIntent(intent: IntentResolution): AgentResponse {
    if (intent.disposition === "clarify") {
      const response =
        intent.missingSlots?.includes("name")
          ? "What should I call the new circle?"
          : "What would you like me to do with your location?";
      return {
        response,
        isComplete: false,
        needsConsent: false,
        intent,
      };
    }
    if (intent.disposition === "read_answer") {
      const count = intent.slots.count;
      return {
        response:
          typeof count === "number"
            ? `You have ${count} ${count === 1 ? "Circle" : "Circles"}.`
            : "I will answer that from the current Location data.",
        isComplete: typeof count === "number",
        needsConsent: false,
        intent,
      };
    }
    if (intent.disposition === "unsupported") {
      const response =
        intent.reason === "sos_send_blocked"
          ? "I cannot send an SOS by voice. I can open the SOS review screen instead."
          : intent.reason === "action_unavailable"
            ? "That action is not available in the current Agent One context."
            : "I do not have a safe, supported action for that request yet.";
      return { response, isComplete: false, needsConsent: false, intent };
    }
    return {
      response: "I found the matching Agent One action. I will continue through the in-app policy and confirmation flow.",
      isComplete: false,
      needsConsent: false,
      intent,
    };
  }

  private routeToAgent(
    agentId: string,
    message: string,
    userId: string,
    sessionState: Record<string, unknown>
  ): AgentResponse {
    // For now, return a message indicating local mode is available
    // Full agent logic is in the Swift implementation
    const step = (sessionState.step as string) || 'greeting';

    if (agentId === AGENT_IDS.identity && step === 'greeting') {
      return {
        response: `👋 Hi! I'm your Identity assistant.`,
        sessionState: { step: 'title', collected: {} },
        isComplete: false,
        needsConsent: false,
      };
    }

    return {
      response: 'This agent conversation is in progress.',
      sessionState,
      isComplete: false,
      needsConsent: false,
    };
  }
}
