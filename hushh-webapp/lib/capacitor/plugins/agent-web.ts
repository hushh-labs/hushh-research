/**
 * Hushh Local Agent - Web Implementation
 * 
 * DEV: Routes to remote API by default (useRemoteLLM: true).
 * When set to local, uses on-device intent classification and agents.
 */

import type { HushhAgentPlugin, AgentResponse, AgentInfo } from "../index";
import { SettingsService } from "../../services/settings-service";

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
    
    const delegation = this.classifyIntentSync(message);
    if (delegation.hasDelegate) {
      return this.routeToAgent(delegation.targetAgent, message, userId, sessionState || {});
    }
    
    return {
      response: `👋 Hi! I can help with investment analysis (Kai) and PKM domains. What would you like to do?`,
      isComplete: false,
      needsConsent: false,
    };
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
