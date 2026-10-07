import { registerPlugin } from "@capacitor/core";

/** Public-client OAuth only. The provider code returns to this process, never the hub. */
export interface GoogleConnectorAuthPlugin {
  open(options: {
    authorizationUrl: string;
    redirectUri: string;
    expectedUserId: string;
    devEnabled: boolean;
  }): Promise<{ redirectUrl: string }>;
}

export const GoogleConnectorAuth = registerPlugin<GoogleConnectorAuthPlugin>("GoogleConnectorAuth");
