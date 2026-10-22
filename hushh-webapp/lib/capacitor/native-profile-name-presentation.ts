import { hasNativeProfileScene, type HushhNativeDrawersPlugin } from "./native-drawers";
import { NativeProfileNameFence, validNativeProfileNameProjection,
  type NativeProfileNameAction, type NativeProfileNameEdit, type NativeProfileNameIdentity,
  type NativeProfileNameProjection, type NativeProfileNameScenePort } from "./native-profile-name-scene";
import { NativeProfileScenePresentation, type NativeProfileSceneActions } from "./native-profile-scene-presentation";

export type NativeProfileNameActions<T> = {
  edit: (text: string, composing: boolean, revision: number) => void;
  save: () => Promise<{ kind: "saved"; value: T } | { kind: "retained" }>;
  saved: (value: T) => void;
  cancel: () => void;
};
type Plugin = HushhNativeDrawersPlugin & NativeProfileNameScenePort;
export function hasNativeProfileNameScene(plugin: HushhNativeDrawersPlugin): plugin is Plugin {
  return hasNativeProfileScene(plugin, "account-name");
}

/** Compatibility facade: preserve the qualified name port and private schema
 * while ordinary Profile scenes share one ordering/retirement implementation. */
export class NativeProfileNamePresentation<T> {
  private readonly presentation: NativeProfileScenePresentation<NativeProfileNameProjection, NativeProfileNameEdit, NativeProfileNameAction, T>;
  constructor(readonly identity: NativeProfileNameIdentity, plugin: Plugin,
    ownerIsCurrent: () => boolean, onPhase: (phase: "active" | "blocked" | "fallback") => void) {
    this.presentation = new NativeProfileScenePresentation<NativeProfileNameProjection, NativeProfileNameEdit, NativeProfileNameAction, T>(identity, {
      source: plugin,
      apply: state => plugin.applyProfileNameScene(state),
      confirm: action => plugin.confirmProfileNameAction(action),
      settle: action => plugin.settleProfileNameAction(action),
      retire: () => plugin.retireProfileNameScene(identity),
      edits: listener => plugin.addListener("profileNameEdit", listener),
      choices: listener => plugin.addListener("profileNameAction", listener),
    }, new NativeProfileNameFence(identity), validNativeProfileNameProjection, ownerIsCurrent, onPhase);
  }
  private actions(value: NativeProfileNameActions<T>): NativeProfileSceneActions<NativeProfileNameEdit, NativeProfileNameAction, T> {
    return { edit: event => value.edit(event.text, event.composing, event.editRevision),
      commit: () => value.save(), saved: value.saved, cancel: value.cancel };
  }
  listen(): Promise<boolean> { return this.presentation.listen(); }
  publish(state: NativeProfileNameProjection, actions: NativeProfileNameActions<T>): boolean {
    return this.presentation.publish(state, this.actions(actions));
  }
  refreshActions(actions: NativeProfileNameActions<T>): void { this.presentation.refreshActions(this.actions(actions)); }
  retire(): Promise<boolean> { return this.presentation.retire(); }
}
