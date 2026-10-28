"use client";

import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import { NativePaymentsFence, validNativePaymentsProjection, validNativePaymentsFinalEdit, type NativePaymentsDraft, type NativePaymentsScene, type NativePaymentsScenePort } from "@/lib/capacitor/native-profile-payments-scene";
import type { PrivateProfileEditorAdapter, PrivateProfileEditorModel } from "@/lib/capacitor/native-profile-private-editor";
import { NativePrivateProfileForm } from "./native-private-profile-form";

const adapter: PrivateProfileEditorAdapter<NativePaymentsDraft, NativePaymentsScene> = {
  valid: validNativePaymentsProjection, validFinal: validNativePaymentsFinalEdit, fence: identity => new NativePaymentsFence(identity),
  connect: identity => {
    const source = nativeDrawers() as ReturnType<typeof nativeDrawers> & NativePaymentsScenePort;
    return { port: { source, apply: state => source.applyProfilePaymentsScene(state), confirm: action => source.confirmProfilePaymentsAction(action),
      settle: action => source.settleProfilePaymentsAction(action), retire: () => source.retireProfilePaymentsScene(identity),
      edits: callback => source.addListener("profilePaymentsEdit", callback), choices: callback => source.addListener("profilePaymentsAction", callback) },
      finalEdits: callback => source.addListener("profilePaymentsFinalEdit", callback) };
  },
};
export function NativePaymentsEditor(props: { scene: NativePaymentsScene; model: PrivateProfileEditorModel<NativePaymentsDraft>; owner: string; destinationId: string;
  onClose: () => void; onSaved?: () => void; onFallback: () => void }) {
  return <NativePrivateProfileForm {...props} adapter={adapter} />;
}
