import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { CallView } from "@/lib/direct-messages/call-session";

export type NativeCallView = CallView & { verification: string | null };
export interface HushhCallingPlugin {
  initialize(options: { ownerId: string }): Promise<{ available: boolean }>;
  start(options: { conversationId?: string; personRef?: string }): Promise<void>;
  answer(): Promise<void>;
  end(options: { decline: boolean }): Promise<void>;
  mute(): Promise<void>;
  verify(options: { fingerprint: string; accepted: boolean }): Promise<void>;
  addListener(event: "callState", callback: (view: NativeCallView) => void): Promise<PluginListenerHandle>;
}

/** iOS only. Other native platforms remain unavailable until their OS adapter exists. */
export const HushhCalling = registerPlugin<HushhCallingPlugin>("HushhCalling");
