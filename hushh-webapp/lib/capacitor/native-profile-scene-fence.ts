import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import { NativeOwnedEditorFence } from "./native-owned-editor-fence";

/** Shared metadata ordering only. Each authored private scene supplies its
 * closed payload validators; this class never interprets fields or performs
 * an account, preference, support, or routing operation. */
export type NativeProfileSceneIdentity = NativeDrawerIdentity & { scene: string; destinationId?: string };
export type NativeProfileSceneState = NativeProfileSceneIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  acknowledgedEditRevision: number;
  canSave: boolean;
  busy: boolean;
};
export type NativeProfileSceneEdit = NativeProfileSceneIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  editRevision: number;
};
export type NativeProfileSceneAction = NativeProfileSceneEdit & {
  sequence: number;
  action: "save" | "cancel" | "change";
};
type Validators<P, E, A> = {
  state: (value: P) => boolean;
  edit: (value: E) => boolean;
  action: (value: A, state: P) => boolean;
};
function sameScene(a: NativeProfileSceneIdentity, b: NativeProfileSceneIdentity): boolean {
  return sameNativeDrawer(a, b) && a.scene === b.scene && a.destinationId === b.destinationId;
}

/** Compatibility owner; Profile's identity and validators remain unchanged. */
export class NativeProfileSceneFence<P extends NativeProfileSceneState, E extends NativeProfileSceneEdit, A extends NativeProfileSceneAction>
  extends NativeOwnedEditorFence<NativeProfileSceneIdentity, P, E, A> {
  constructor(identity: NativeProfileSceneIdentity, valid: Validators<P, E, A>) { super(identity, valid, sameScene); }
}
