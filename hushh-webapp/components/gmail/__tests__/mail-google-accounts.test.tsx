import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { advanceVaultSessionEpoch } from '@/lib/vault/session-epoch';
import { MailGoogleAccounts } from '../mail-google-accounts';

const fixture = vi.hoisted(() => ({ uid: 'owner', list: vi.fn(), disconnect: vi.fn(), connect: vi.fn() }));
vi.mock('@/lib/services/auth-service', () => ({ AuthService: { getCurrentUser: () => ({ uid: fixture.uid }) } }));
vi.mock('@/lib/services/private-agent-specialist-chat', () => ({ ownerContentIsPrivate: async () => true }));
vi.mock('@/lib/services/private-google-connections', () => ({ privateMailAccounts: fixture.list, disconnectPrivateMailAccount: fixture.disconnect }));
vi.mock('@/lib/one/google-native-connect', () => ({ connectGoogleConnector: fixture.connect, connectRefusalMessage: (code: string) => code }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => ({}) }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const work = { accountId: 'a'.repeat(32), credentialId: '11111111-2222-4333-8444-555555555555', email: 'work@example.com', provider: 'google', status: 'connected', isDefault: true };
const personal = { ...work, accountId: 'b'.repeat(32), credentialId: '22222222-2222-4333-8444-555555555555', email: 'personal@example.com', isDefault: false };
const props = { session: { userId: 'owner', vaultKey: 'synthetic-key', vaultOwnerToken: 'synthetic-capability' }, enabled: true, fallback: null, confirmTransition: vi.fn(), onChanged: vi.fn() };
beforeEach(() => { fixture.uid = 'owner'; fixture.list.mockReset().mockResolvedValue([work, personal]); fixture.connect.mockReset().mockResolvedValue({ ok: true, status: 'connected' }); fixture.disconnect.mockReset().mockResolvedValue({ disconnected: true, providerRevoked: true }); });
afterEach(cleanup);

it('preserves default-mailbox controls when an older private agent cannot list accounts', async () => {
  fixture.list.mockRejectedValue(new Error('Unsupported account inventory'));
  render(<MailGoogleAccounts {...props} fallback={<button>Reconnect default mailbox</button>} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not load mailboxes');
  expect(screen.getByRole('button', { name: 'Reconnect default mailbox' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add Google account' })).toBeDisabled();
});

it('targets reconnect and disconnect to one mailbox and keeps the other visible', async () => {
  render(<MailGoogleAccounts {...props} />);
  await screen.findByText('personal@example.com');
  fireEvent.click(screen.getAllByRole('button', { name: 'Reconnect' })[1]!);
  await waitFor(() => expect(fixture.connect).toHaveBeenCalledWith('gmail', expect.objectContaining({ mailAccount: { mode: 'reconnect', accountId: personal.accountId, credentialId: personal.credentialId } })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add Google account' })).toBeEnabled());
  fixture.list.mockResolvedValue([work]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[1]!);
  await waitFor(() => expect(fixture.disconnect).toHaveBeenCalledWith(personal.accountId, personal.credentialId));
  await waitFor(() => expect(screen.queryByText('personal@example.com')).toBeNull());
  expect(screen.getByText('work@example.com')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Add Google account' }));
  await waitFor(() => expect(fixture.connect).toHaveBeenLastCalledWith('gmail', expect.objectContaining({ mailAccount: { mode: 'add' } })));
});

it('does not read a hidden pane or publish an inventory after its owner session retires', async () => {
  let release!: (accounts: unknown[]) => void;
  fixture.list.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const view = render(<MailGoogleAccounts {...props} enabled={false} />);
  expect(fixture.list).not.toHaveBeenCalled();
  view.rerender(<MailGoogleAccounts {...props} />);
  await waitFor(() => expect(fixture.list).toHaveBeenCalledOnce());
  fixture.uid = 'other-owner'; advanceVaultSessionEpoch();
  view.rerender(<MailGoogleAccounts {...props} session={{ ...props.session, userId: 'other-owner' }} />);
  fixture.list.mockResolvedValue([]);
  await act(async () => { release([work, personal]); });
  await screen.findByText('No mailboxes connected.');
  expect(screen.queryByText('work@example.com')).toBeNull();
});
