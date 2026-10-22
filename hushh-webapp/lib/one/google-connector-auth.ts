import { GoogleConnectorAuth } from '@/lib/capacitor/google-connector-auth';
import { AuthService } from '@/lib/services/auth-service';

export async function openGoogleConnectorAuth(authorizationUrl: string, redirectUri: string): Promise<string> {
  const expectedUserId = AuthService.getCurrentUser()?.uid;
  if (!expectedUserId) throw new Error('PRIVATE_AGENT_SIGN_IN_REQUIRED');
  const devEnabled = process.env.NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED === 'true' &&
    ['dev', 'development', 'uat'].includes(process.env.NEXT_PUBLIC_APP_ENV ?? '');
  const result = await GoogleConnectorAuth.open({ authorizationUrl, redirectUri, expectedUserId, devEnabled });
  if (AuthService.getCurrentUser()?.uid !== expectedUserId) throw new Error('POD_OWNER_CHANGED');
  return result.redirectUrl;
}
