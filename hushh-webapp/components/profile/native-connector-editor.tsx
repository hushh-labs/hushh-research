"use client";

import type { CustomConnectorSettingsModel } from "@/components/agent/custom-connectors-settings";
import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import { NativeConnectorFence, validNativeConnectorProjection, validNativeConnectorFinalEdit,
  validNativeCustomConnectorDraft, type NativeConnectorDraft, type NativeConnectorScene, type NativeConnectorScenePort } from "@/lib/capacitor/native-profile-connector-scene";
import type { PrivateProfileEditorAdapter, PrivateProfileEditorModel } from "@/lib/capacitor/native-profile-private-editor";
import { NativePrivateProfileForm } from "./native-private-profile-form";

export type NativeConnectorEditorModel = PrivateProfileEditorModel<NativeConnectorDraft>;
const adapter: PrivateProfileEditorAdapter<NativeConnectorDraft, NativeConnectorScene> = {
  valid: validNativeConnectorProjection, validFinal: validNativeConnectorFinalEdit, fence: identity => new NativeConnectorFence(identity),
  connect: identity => {
    const source = nativeDrawers as typeof nativeDrawers & NativeConnectorScenePort;
    return { port: { source, apply: state => source.applyProfileConnectorScene(state), confirm: action => source.confirmProfileConnectorAction(action),
      settle: action => source.settleProfileConnectorAction(action), retire: () => source.retireProfileConnectorScene(identity),
      edits: callback => source.addListener("profileConnectorEdit", callback), choices: callback => source.addListener("profileConnectorAction", callback) },
      finalEdits: callback => source.addListener("profileConnectorFinalEdit", callback) };
  },
};
/** Compatibility facade: existing connector callers keep their contract. */
export function NativeConnectorEditor({ model, owner, destinationId, onClose, onFallback }: {
  model: CustomConnectorSettingsModel["nativeEditor"]; owner: string; destinationId: string; onClose: () => void; onFallback: () => void;
}) {
  return <NativeConnectorForm owner={owner} destinationId={destinationId} onClose={onClose} onFallback={onFallback} scene="connector-custom-server"
    model={{ ...model, canSave: !!model.draft.name.trim() && !!model.draft.endpoint.trim(),
      changeDraft: (draft, expected) => validNativeCustomConnectorDraft(draft) && model.changeDraft(draft, expected) }} />;
}
export function NativeConnectorForm(props: {
  model: NativeConnectorEditorModel; scene: NativeConnectorScene; owner: string; destinationId: string; onClose: () => void; onSaved?: () => void; onFallback: () => void;
}) { return <NativePrivateProfileForm {...props} adapter={adapter} />; }
