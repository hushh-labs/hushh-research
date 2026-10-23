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

export type PrivateMailAccount = PrivateGoogleStatus & {
  accountId: string; credentialId: string; email: string | null; provider: 'google'; isDefault: boolean;
};

export async function privateMailAccounts(): Promise<PrivateMailAccount[]> {
  const response = await ApiService.ownerPodRequest('connectors/gmail/accounts', { method: 'GET' });
  if (!response.ok) throw new Error('Your private agent could not load your mailboxes. Update your agent if this continues.');
  const value: unknown = await response.json();
  const accounts = (value as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(accounts) || accounts.length > 20) throw new Error('Unsupported mailbox list.');
  const ids = new Set<string>();
  return accounts.map((item: Omit<PrivateMailAccount, 'connectorId'>) => {
    if (!item || !/^[a-f0-9]{32}$/.test(item.accountId) || ids.has(item.accountId) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.credentialId) ||
        item.provider !== 'google' || !['connected', 'needs_reauth'].includes(item.status) ||
        typeof item.isDefault !== 'boolean' || (item.email !== null && typeof item.email !== 'string'))
      throw new Error('Unsupported mailbox list.');
    ids.add(item.accountId);
    return { ...item, connectorId: 'gmail', capabilities: { read: item.status === 'connected' && item.capabilities?.read === true, manage: item.status === 'connected' && item.capabilities?.manage === true } };
  });
}

export async function disconnectPrivateMailAccount(accountId: string, credentialId: string): Promise<{ disconnected: boolean; providerRevoked: boolean | null }> {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Unsupported mailbox.');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(credentialId)) throw new Error('Unsupported mailbox connection.');
  const response = await ApiService.ownerPodRequest(`connectors/gmail/accounts/${accountId}?credential_id=${credentialId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Your private agent could not disconnect this mailbox.');
  const value = await response.json() as { accountId?: string; status?: string; providerRevoked?: unknown };
  if (value.accountId !== accountId || !['absent', 'connected', 'needs_reauth'].includes(value.status ?? '') ||
      ![true, false, null].includes(value.providerRevoked as boolean | null)) throw new Error('Your private agent could not confirm the disconnect. Refresh Mail.');
  return { disconnected: value.status === 'absent', providerRevoked: value.providerRevoked as boolean | null };
}

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
