"use client";

import { useLayoutEffect } from "react";
import { useNativeOwnedChoice } from "./use-native-owned-choice";
import type { SemanticChoiceOption } from "./native-choice-items";

export type NativeChoiceControl = ReturnType<typeof useNativeOwnedChoice>;
type Props = {
  active: boolean;
  options: readonly SemanticChoiceOption[] | null;
  value: string;
  disabled: boolean;
  label?: string;
  trigger?: { current: HTMLButtonElement | null };
  onValueChange: (value: string) => void;
  publish: (control: NativeChoiceControl | null) => void;
};

/** No visual replacement. The original primitive and form owner keep their
 * tree position on SSR, hydration and native admission. Only the popup differs. */
export function NativeChoiceController(props: Props) {
  return props.active ? <ActiveChoiceController {...props} /> : null;
}
function ActiveChoiceController({ publish, trigger, ...props }: Props) {
  const choice = useNativeOwnedChoice(props, trigger);
  useLayoutEffect(() => {
    publish(choice);
  }, [publish, choice]);
  useLayoutEffect(() => () => publish(null), [publish]);
  return null;
}
