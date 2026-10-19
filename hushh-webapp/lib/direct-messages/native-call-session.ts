import type { PluginListenerHandle } from "@capacitor/core";
import { HushhCalling } from "@/lib/capacitor/calling";
import type { CallView, VerifyPeer } from "./call-session";
import { dispatchDirectMessagesUpdated } from "./direct-message-events";

/** UI-only adapter. Native CallKit owns call lifetime after the view unmounts. */
export class NativeCallSession {
  private listener: PluginListenerHandle | null = null;
  private disposed = false;
  private verification: string | null = null;
  private announcedCall: string | null = null;
  private callId: string | null = null;
  constructor(private readonly ownerId: string, private readonly publish: (view: CallView) => void,
    private readonly verifyPeer: VerifyPeer) {}
  async initialize(): Promise<boolean> {
    this.listener = await HushhCalling.addListener("callState", view => {
      if (this.disposed) return;
      this.callId = view.call?.id ?? null;
      if (view.call && view.call.id !== this.announcedCall) {
        this.announcedCall = view.call.id;
        dispatchDirectMessagesUpdated({ userId: this.ownerId, conversationId: view.call.conversationId, messageId: null, source: "call" });
      }
      this.publish(view);
      if (!view.verification || !view.call) { this.verification = null; return; }
      const callId = view.call.id;
      const fingerprint = view.verification;
      const comparison = `${callId}:${fingerprint}`;
      if (comparison === this.verification) return;
      this.verification = comparison;
      void this.verifyPeer(view.call?.conversationId ?? "", fingerprint).then(accepted => {
        if (!this.disposed && this.verification === comparison && this.callId === callId) {
          return HushhCalling.verify({ callId, fingerprint, accepted });
        }
        return undefined;
      }).catch(() => undefined);
    });
    if (this.disposed) { await this.listener.remove(); return false; }
    return (await HushhCalling.initialize({ ownerId: this.ownerId })).available;
  }
  start(conversationId: string | null, personRef?: string | null): Promise<void> {
    return HushhCalling.start({ ...(conversationId ? { conversationId } : {}), ...(personRef ? { personRef } : {}) });
  }
  answer = async (expectedCallId = this.callId): Promise<void> => {
    if (expectedCallId) await HushhCalling.answer({ callId: expectedCallId });
  };
  end = async (decline = false, expectedCallId = this.callId): Promise<void> => {
    if (expectedCallId) await HushhCalling.end({ callId: expectedCallId, decline }).catch(() => undefined);
  };
  mute = (expectedCallId = this.callId): void => {
    if (expectedCallId) void HushhCalling.mute({ callId: expectedCallId }).catch(() => undefined);
  };
  dispose(): void { this.disposed = true; void this.listener?.remove(); this.listener = null; }
}
