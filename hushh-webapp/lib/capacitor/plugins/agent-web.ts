/** Compatibility boundary for the retired local phrase router. */
import type { HushhAgentPlugin, AgentResponse } from "../index";

export class HushhAgentWeb implements HushhAgentPlugin {
  async handleMessage(): Promise<AgentResponse> {
    return { response: "__USE_REMOTE_API__", isComplete: false, needsConsent: false };
  }
  async classifyIntent(): Promise<never> {
    throw new Error("Local phrase classification is retired. Use the semantic command proposal endpoint.");
  }
  async getAgentInfo() {
    return { agents: [], version: "2.0.0", protocolVersion: "HCT-1.0" };
  }
}
