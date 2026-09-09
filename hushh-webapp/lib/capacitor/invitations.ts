import { registerPlugin } from "@capacitor/core";

export type SmsComposeOutcome =
  | "queued_or_sent"
  | "opened"
  | "cancelled"
  | "failed"
  | "unavailable";
export interface HushhInvitationsPlugin {
  getCapabilities(): Promise<{ sms: boolean }>;
  composeSms(options: {
    recipient: string;
    body: string;
  }): Promise<{ outcome: SmsComposeOutcome }>;
}

export const HushhInvitations = registerPlugin<HushhInvitationsPlugin>(
  "HushhInvitations",
  {
    web: () =>
      Promise.resolve({
        getCapabilities: async () => ({ sms: false }),
        composeSms: async () => ({ outcome: "unavailable" as const }),
      }),
  },
);
