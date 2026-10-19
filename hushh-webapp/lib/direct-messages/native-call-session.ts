import type { PluginListenerHandle } from "@capacitor/core";
import { HushhCalling } from "@/lib/capacitor/calling";
import type { CallView, VerifyPeer } from "./call-session";

/** UI-only adapter. Native CallKit owns call lifetime after the view unmounts. */
export class NativeCallSession {
  private listener: PluginListenerHandle | null = null;
  private disposed = false;
  private verification: string | null = null;
  constructor(private readonly ownerId: string, private readonly publish: (view: CallView) => void,
    private readonly verifyPeer: VerifyPeer) {}
  async initialize(): Promise<boolean> {
    this.listener = await HushhCalling.addListener("callState", view => {
      if (this.disposed) return;
      this.publish(view);
      if (!view.verification) { this.verification = null; return; }
      if (view.verification === this.verification) return;
      const fingerprint = view.verification;
      this.verification = fingerprint;
      void this.verifyPeer(view.call?.conversationId ?? "", fingerprint).then(accepted => {
        if (!this.disposed && this.verification === fingerprint) return HushhCalling.verify({ fingerprint, accepted });
        return undefined;
      }).catch(() => undefined);
    });
    if (this.disposed) { await this.listener.remove(); return false; }
    return (await HushhCalling.initialize({ ownerId: this.ownerId })).available;
  }
  start(conversationId: string | null, personRef?: string | null): Promise<void> {
    return HushhCalling.start({ ...(conversationId ? { conversationId } : {}), ...(personRef ? { personRef } : {}) });
  }
  answer = (): Promise<void> => HushhCalling.answer();
  end = async (decline = false): Promise<void> => HushhCalling.end({ decline }).catch(() => undefined);
  mute = (): void => { void HushhCalling.mute().catch(() => undefined); };
  dispose(): void { this.disposed = true; void this.listener?.remove(); this.listener = null; }
}
