import { retainNativeFeedbackForm, refreshNativeFeedback } from "./native-feedback";
import { sameNativeDrawer } from "./native-drawers";
import { NativeProfileSceneFence, type NativeProfileSceneAction, type NativeProfileSceneEdit,
  type NativeProfileSceneIdentity, type NativeProfileSceneState } from "./native-profile-scene-fence";
import { NativeOwnedScenePresentation, type NativeOwnedSceneReceipt, type NativeOwnedScenePort,
  type NativeOwnedSceneActions } from "./native-owned-scene-presentation";

export type NativeProfileSceneReceipt = NativeOwnedSceneReceipt<NativeProfileSceneIdentity>;
export type NativeProfileScenePort<P, E, A> = NativeOwnedScenePort<NativeProfileSceneIdentity, P, E, A>;
export type NativeProfileSceneActions<E, A, T> = NativeOwnedSceneActions<E, A, T>;

/** Profile keeps its existing identity, scene validation and feedback owner.
 * Only transport/lifetime mechanics are shared with route-owned native forms. */
export class NativeProfileScenePresentation<P extends NativeProfileSceneState, E extends NativeProfileSceneEdit, A extends NativeProfileSceneAction, T>
  extends NativeOwnedScenePresentation<NativeProfileSceneIdentity, P, E, A, T> {
  constructor(identity: NativeProfileSceneIdentity, port: NativeProfileScenePort<P, E, A>, fence: NativeProfileSceneFence<P, E, A>,
    validState: (state: P) => boolean, ownerIsCurrent: () => boolean, onPhase: (phase: "active" | "blocked" | "fallback") => void,
    closeOnSaved = true, copyState: (state: P) => P = state => ({ ...state }), interactionIsCurrent = ownerIsCurrent) {
    super(identity, port, fence, validState, ownerIsCurrent, onPhase, closeOnSaved, copyState, interactionIsCurrent,
      (a, b) => sameNativeDrawer(a, b) && a.scene === b.scene && a.destinationId === b.destinationId,
      { retain: (current, ready) => retainNativeFeedbackForm({ identity, scene: identity.scene,
        destinationId: identity.destinationId, current, ready }), refresh: refreshNativeFeedback });
  }
}
