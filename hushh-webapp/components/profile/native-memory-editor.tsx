"use client";

import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import { NativeMemoryFence, validNativeMemoryProjection, validNativeMemoryFinalEdit, type NativeMemoryDraft, type NativeMemoryScenePort } from "@/lib/capacitor/native-profile-memory-scene";
import type { PrivateProfileEditorAdapter, PrivateProfileEditorModel } from "@/lib/capacitor/native-profile-private-editor";
import { NativePrivateProfileForm } from "./native-private-profile-form";

const adapter: PrivateProfileEditorAdapter<NativeMemoryDraft, "memory-financial-context"> = {
  valid: validNativeMemoryProjection, validFinal: validNativeMemoryFinalEdit, fence: identity => new NativeMemoryFence(identity),
  connect: identity => {
    const source = nativeDrawers() as ReturnType<typeof nativeDrawers> & NativeMemoryScenePort;
    return { port: { source, apply: state => source.applyProfileMemoryScene(state), confirm: action => source.confirmProfileMemoryAction(action),
      settle: action => source.settleProfileMemoryAction(action), retire: () => source.retireProfileMemoryScene(identity),
      edits: callback => source.addListener("profileMemoryEdit", callback), choices: callback => source.addListener("profileMemoryAction", callback) },
      finalEdits: callback => source.addListener("profileMemoryFinalEdit", callback) };
  },
};
export function NativeMemoryEditor(props: { model: PrivateProfileEditorModel<NativeMemoryDraft>; owner: string; destinationId: string;
  onClose: () => void; onSaved?: () => void; onFallback: () => void }) {
  return <NativePrivateProfileForm {...props} scene="memory-financial-context" adapter={adapter} />;
}
