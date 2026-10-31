import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { PacketPublicSummaryControlModel } from "./packet-public-summary-control";

type Ports = {
  text: (key: string, text: string) => NativeDrawerRow[];
  bind: (key: string, label: string, action: () => void | Promise<unknown>, extra?: Partial<NativeDrawerRow>) => NativeDrawerRow;
  toggle: (key: string, label: string, selected: boolean, enabled: boolean, update: (next: boolean) => void) => NativeDrawerRow;
};
/** Native presentation reuses the web publication model and the existing guarded drawer callbacks. */
export function packetPublicSummaryNative(model: PacketPublicSummaryControlModel | undefined, { text, bind, toggle }: Ports): NativeDrawerSection[] {
  if (!model?.visible) return [];
  return [{ id: "packet-public-summary", title: "Public summary", rows: [
    ...text("packet-public-disclosure", model.notice),
    ...(!model.enabled ? [toggle("packet-public-ack", "I agree to publish this summary", model.acknowledged, !model.busy, model.acknowledge)] : []),
    bind("packet-public-submit", model.enabled ? "Hide public summary" : "Publish summary", () => { void model.submit(); },
      { enabled: !model.busy && (model.enabled || model.acknowledged) }),
    ...(!model.enabled && model.canWithdraw ? [bind("packet-public-hide", "Hide public summary", () => { void model.withdraw(); }, { enabled: !model.busy })] : []),
    ...text("packet-public-message", model.message),
  ] }];
}
