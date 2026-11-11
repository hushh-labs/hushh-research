import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { CallView } from "@/lib/direct-messages/call-session";
import type { SmsCallIntent } from "@/lib/direct-messages/sms-call-escalation";

export type NativeCallView = CallView & { verification: string | null };
export interface HushhCallingPlugin {
  initialize(options: { ownerId: string }): Promise<{ available: boolean; deviceId?: string }>;
  start(options: { conversationId?: string; personRef?: string; sms?: SmsCallIntent }): Promise<void>;
  answer(options: { callId: string }): Promise<void>;
  end(options: { callId: string; decline: boolean }): Promise<void>;
  mute(options: { callId: string }): Promise<void>;
  verify(options: { callId: string; fingerprint: string; accepted: boolean }): Promise<void>;
  addListener(event: "callState", callback: (view: NativeCallView) => void): Promise<PluginListenerHandle>;
}

/** Native system-call adapters are admitted independently by the calling service. */
export const HushhCalling = registerPlugin<HushhCallingPlugin>("HushhCalling");
