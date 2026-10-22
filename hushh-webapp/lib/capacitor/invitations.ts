import { registerPlugin } from "@capacitor/core";

export type SmsComposeOutcome =
  | "queued_or_sent"
  | "opened"
  | "cancelled"
  | "failed"
  | "unavailable";
export interface HushhInvitationsPlugin {
  getCapabilities(): Promise<{ sms: boolean; maxSmsRecipients?: number }>;
  composeSms(options: {
    recipient: string;
    body: string;
  }): Promise<{ outcome: SmsComposeOutcome }>;
  composeSmsBatch(options: {
    recipients: string[];
    body: string;
  }): Promise<{ outcome: SmsComposeOutcome }>;
}

export const HushhInvitations = registerPlugin<HushhInvitationsPlugin>(
  "HushhInvitations",
  {
    web: () =>
      Promise.resolve({
        getCapabilities: async () => ({ sms: false, maxSmsRecipients: 0 }),
        composeSms: async () => ({ outcome: "unavailable" as const }),
        composeSmsBatch: async () => ({ outcome: "unavailable" as const }),
      }),
  },
);
