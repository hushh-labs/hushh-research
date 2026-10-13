// lib/agents/ports.ts

/**
 * Agent Port Configuration
 *
 * SINGLE SOURCE OF TRUTH: consent-protocol/hushh_mcp/constants.py:AGENT_PORTS
 *
 * This file mirrors the Python backend's port assignments.
 * In production, these should be loaded from environment variables
 * which are populated from Google Secrets Manager.
 *
 * Usage:
 * - Development: Uses defaults from this file
 * - Production: Loads from AGENT_PORTS_JSON env var (from Secrets Manager)
 */

// Default port assignments (matches constants.py; food/professional removed)
const DEFAULT_AGENT_PORTS: Record<string, number> = {
  agent_orchestrator: 10000,
  agent_identity: 10003,
  agent_shopper: 10004,
};

/**
 * Load agent ports from environment or use defaults.
 *
 * For production, set AGENT_PORTS_JSON in .env:
 * AGENT_PORTS_JSON={"agent_orchestrator":10000,...}
 *
 * This can be populated from Google Secrets Manager.
 */
function loadAgentPorts(): Record<string, number> {
  const portsJson = process.env.AGENT_PORTS_JSON;

  if (portsJson) {
    try {
      const parsed = JSON.parse(portsJson);
      console.log("[AgentPorts] Loaded from environment");
      return { ...DEFAULT_AGENT_PORTS, ...parsed };
    } catch (_e) {
      console.warn(
        "[AgentPorts] Failed to parse AGENT_PORTS_JSON, using defaults"
      );
    }
  }

  return DEFAULT_AGENT_PORTS;
}

// Exported port map
export const AGENT_PORTS = loadAgentPorts();

/**
 * Get port for a specific agent.
 *
 * @throws Error if agent not found
 */
export function getAgentPort(agentId: string): number {
  const port = AGENT_PORTS[agentId];
  if (!port) {
    throw new Error(
      `Unknown agent: ${agentId}. Available: ${Object.keys(AGENT_PORTS).join(
        ", "
      )}`
    );
  }
  return port;
}

/**
 * Get all available agent IDs.
 */
export function getAvailableAgents(): string[] {
  return Object.keys(AGENT_PORTS);
}

/**
 * Check if an agent ID is valid.
 */
export function isValidAgent(agentId: string): boolean {
  return agentId in AGENT_PORTS;
}
