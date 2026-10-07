import { registerPlugin } from '@capacitor/core';
import { AuthService } from '@/lib/services/auth-service';

/** Public-client OAuth only. The provider code returns to this process, never the hub. */
const GoogleConnectorAuth = registerPlugin<{
  open(options: { authorizationUrl: string; redirectUri: string; expectedUserId: string; devEnabled: boolean }): Promise<{ redirectUrl: string }>;
}>('GoogleConnectorAuth');

export async function openGoogleConnectorAuth(authorizationUrl: string, redirectUri: string): Promise<string> {
  const expectedUserId = AuthService.getCurrentUser()?.uid;
  if (!expectedUserId) throw new Error('PRIVATE_AGENT_SIGN_IN_REQUIRED');
  const devEnabled = process.env.NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED === 'true' &&
    ['dev', 'development'].includes(process.env.NEXT_PUBLIC_APP_ENV ?? '');
  const result = await GoogleConnectorAuth.open({ authorizationUrl, redirectUri, expectedUserId, devEnabled });
  if (AuthService.getCurrentUser()?.uid !== expectedUserId) throw new Error('POD_OWNER_CHANGED');
  return result.redirectUrl;
}
