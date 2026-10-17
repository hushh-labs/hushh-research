import { ApiService } from './api-service';
import type { GoogleConnector } from '@/lib/one/connector-credential-seal';

export class PrivateGoogleUnsupportedError extends Error {
  readonly code = 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE';
  constructor(operation: string) {
    super(`${operation} is not available for your private agent yet.`);
    this.name = 'PrivateGoogleUnsupportedError';
  }
}

/** Old shared-client exchanges cannot handle a public native PKCE code. */
export async function requireSharedGoogleExchange(): Promise<void> {
  const { ownerContentIsPrivate } = await import('./private-agent-specialist-chat');
  if (await ownerContentIsPrivate()) throw new PrivateGoogleUnsupportedError('This shared Google connection flow');
}

export type PrivateGoogleStatus = {
  connectorId: GoogleConnector;
  status: 'connected' | 'needs_reauth' | 'absent';
  accessLevel: 'read' | 'manage' | null;
  capabilities: { read: boolean; manage: boolean };
};

/** Display only grants confirmed by the owner-authenticated pod response. */
export async function privateGoogleStatus(connector: GoogleConnector): Promise<PrivateGoogleStatus> {
  const response = await ApiService.ownerPodRequest(`connectors/${connector}`, { method: 'GET' });
  if (!response.ok) throw new Error('Your private agent could not confirm this Google connection.');
  const value = await response.json() as Partial<PrivateGoogleStatus>;
  if (value.connectorId !== connector || !['connected', 'needs_reauth', 'absent'].includes(value.status ?? ''))
    throw new Error('Your private agent returned an unsupported connection status.');
  const connected = value.status === 'connected';
  return {
    connectorId: connector, status: value.status!,
    accessLevel: connected && (value.accessLevel === 'read' || value.accessLevel === 'manage') ? value.accessLevel : null,
    capabilities: { read: connected && value.capabilities?.read === true, manage: connected && value.capabilities?.manage === true },
  };
}

export async function disconnectPrivateGoogle(connector: GoogleConnector): Promise<void> {
  const response = await ApiService.ownerPodRequest(`connectors/${connector}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Your private agent could not disconnect Google.');
}

export async function confirmPrivateGoogleAction(proposalId: string, kind: 'calendar' | 'gmail_mailbox'): Promise<Record<string, unknown>> {
  const prefix = kind === 'calendar' ? 'gcal' : 'gmod';
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(proposalId)) throw new Error('This action belongs to a different agent. Ask your private agent again.');
  const response = await ApiService.ownerPodRequest(`actions/${proposalId}/confirm`, { method: 'POST' });
  if (!response.ok) throw new Error('Your private agent could not confirm this change. Check the provider before trying again.');
  const value = await response.json() as { proposalId?: string; kind?: string; result?: unknown };
  if (value.proposalId !== proposalId || value.kind !== kind || !value.result || typeof value.result !== 'object' || Array.isArray(value.result))
    throw new Error('Your private agent could not confirm the outcome. Check the provider before trying again.');
  return value.result as Record<string, unknown>;
}
