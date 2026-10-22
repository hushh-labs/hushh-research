import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";

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
function count(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function sameScene(a: NativeProfileSceneIdentity, b: NativeProfileSceneIdentity): boolean {
  return sameNativeDrawer(a, b) && a.scene === b.scene && a.destinationId === b.destinationId;
}

export class NativeProfileSceneFence<
  P extends NativeProfileSceneState,
  E extends NativeProfileSceneEdit,
  A extends NativeProfileSceneAction,
> {
  private state: P | null = null;
  private editRevision = 0;
  private consumedAction = 0;
  private retired = false;

  constructor(private readonly identity: NativeProfileSceneIdentity, private readonly valid: Validators<P, E, A>) {}

  update(state: P): boolean {
    if (this.retired || !this.valid.state(state) || !sameScene(state, this.identity) ||
        this.state && (state.updateSequence <= this.state.updateSequence || state.privacyGeneration !== this.state.privacyGeneration) ||
        state.acknowledgedEditRevision !== this.editRevision) return false;
    this.state = { ...state };
    return true;
  }

  consumeEdit(edit: E): boolean {
    const state = this.state;
    if (this.retired || !state || !this.valid.edit(edit) || !sameScene(edit, this.identity) ||
        edit.privacyGeneration !== state.privacyGeneration || !count(edit.updateSequence, 1) || edit.updateSequence > state.updateSequence ||
        !count(edit.editRevision, 1) || edit.editRevision <= this.editRevision || state.busy) return false;
    this.editRevision = edit.editRevision;
    return true;
  }

  allows(action: A): boolean {
    const state = this.state;
    return !this.retired && !!state && this.valid.action(action, state) && sameScene(action, this.identity) &&
      action.privacyGeneration === state.privacyGeneration && count(action.updateSequence, 1) &&
      (action.action === "cancel" ? action.updateSequence <= state.updateSequence : action.updateSequence === state.updateSequence) &&
      count(action.sequence, 1) && count(action.editRevision) && action.sequence > this.consumedAction && !state.busy &&
      (action.action === "cancel" || state.canSave && action.editRevision === this.editRevision && state.acknowledgedEditRevision === this.editRevision);
  }

  async consumeAction(action: A, confirm: () => Promise<{ valid: boolean }>, ownerIsCurrent: () => boolean): Promise<boolean> {
    if (!this.allows(action) || !ownerIsCurrent()) return false;
    // Consume before awaiting. Unknown outcomes do not authorize a replay.
    this.consumedAction = action.sequence;
    const state = this.state;
    const accepted = await confirm();
    return accepted.valid && !this.retired && ownerIsCurrent() &&
      (action.action === "cancel" ? this.state !== null && !this.state.busy : this.state === state && action.editRevision === this.editRevision);
  }

  retire(): void { this.retired = true; this.state = null; }
}
