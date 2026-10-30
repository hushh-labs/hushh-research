import type { PluginListenerHandle } from "@capacitor/core";
import type { NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import type { NativeProfileSceneFence } from "./native-profile-scene-fence";
import type { NativeProfileScenePort } from "./native-profile-scene-presentation";

/** Shared ordering and retirement only. Each feature still supplies a closed
 * draft schema, its own port, validation, and the existing operation owner. */
export type PrivateProfileIdentity<S extends string> = NativeDrawerIdentity & { family: "profile"; scene: S; destinationId: string };
export type PrivateProfileProjection<D, S extends string> = PrivateProfileIdentity<S> & NativeControlAppearance & {
  draft: D; updateSequence: number; privacyGeneration: number; acknowledgedEditRevision: number; draftRevision: number;
  canSave: boolean; busy: boolean; error: string | null;
};
export type PrivateProfileEdit<D, S extends string> = PrivateProfileIdentity<S> & {
  draft: D; updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean;
};
export type PrivateProfileAction<S extends string> = PrivateProfileIdentity<S> & {
  updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number; action: "save" | "cancel";
};
export type PrivateProfileFinalEdit<D, S extends string> = PrivateProfileEdit<D, S> & { baseDraftRevision: number; acknowledgedEditRevision: number };
export type PrivateProfileEditorModel<D> = {
  current: () => boolean; draft: D; busy: boolean; error: string | null; canSave: boolean;
  inputRevision: () => number; mutationPending: () => boolean; changeDraft: (draft: D, expectedRevision?: number) => boolean;
  save: () => Promise<unknown>;
};
export type PrivateProfileEditorAdapter<D, S extends string> = {
  valid: (state: PrivateProfileProjection<D, S>) => boolean;
  validFinal: (event: PrivateProfileFinalEdit<D, S>, owner: PrivateProfileIdentity<S>) => boolean;
  fence: (owner: PrivateProfileIdentity<S>) => NativeProfileSceneFence<PrivateProfileProjection<D, S>, PrivateProfileEdit<D, S>, PrivateProfileAction<S>>;
  connect: (identity: PrivateProfileIdentity<S>) => {
    port: NativeProfileScenePort<PrivateProfileProjection<D, S>, PrivateProfileEdit<D, S>, PrivateProfileAction<S>>;
    finalEdits: (callback: (event: PrivateProfileFinalEdit<D, S>) => void) => Promise<PluginListenerHandle>;
  };
};
