"use client";

import { Fragment, isValidElement, useRef, type ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import { Button } from "@/components/ui/button";
import type { LucideIcon } from "@/components/icons";
import { useNativeOwnedChoice } from "@/lib/capacitor/use-native-owned-choice";
import { nativeActionArtwork } from "@/lib/capacitor/native-action-artwork";
import { plainChoiceText } from "@/lib/capacitor/native-choice-items";
import type { ActionMenuItem } from "./action-menu";

/** The original trigger is retained. Immediate action callbacks run only after
 * the owned native popup's actual dismissal, through its existing lease. */
export function NativeActionMenu({ label, title, showMobileTitle = true, items, trigger, triggerIcon: Icon, testId, nativePresentation, webFallback }: {
  label: string; title?: string; showMobileTitle?: boolean; items: ActionMenuItem[]; trigger?: ReactNode; triggerIcon?: LucideIcon; testId?: string;
  nativePresentation?: { owner: string | null; context: string };
  webFallback: (open: boolean) => ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerSupported = trigger === undefined || isValidElement<{ asChild?: boolean }>(trigger) &&
    trigger.type !== Fragment && (trigger.type === "button" || trigger.type === Button) && trigger.props.asChild !== true;
  const options = triggerSupported && items.every(item => !item.icon || !!nativeActionArtwork(item.icon)) && items.length > 0 && items.length <= 256 && new Set(items.map(item => item.id)).size === items.length &&
    items.every(item => item.id.length > 0 && item.id.length <= 128 && !!plainChoiceText(item.label)?.trim() && plainChoiceText(item.label)!.trim().length <= 256) ?
    items.map(item => ({ value: item.id, label: plainChoiceText(item.label)!.trim(), disabled: !!(item.disabled || item.busy), ...(nativeActionArtwork(item.icon) ? { artworkId: nativeActionArtwork(item.icon) } : {}) })) : null;
  const choice = useNativeOwnedChoice({ options, value: "", disabled: false, label: title ?? label, showTitle: showMobileTitle,
    context: nativePresentation ? `${nativePresentation.owner ?? ""}\0${nativePresentation.context}` : undefined,
    onValueChange: id => {
      const item = items.find(item => item.id === id);
      if (item && !item.disabled && !item.busy) item.onSelect();
    } }, triggerRef);
  if (choice.fallback) return webFallback(choice.presented);
  // A non-element cannot carry an authored ref or keyboard/button semantics.
  // Keep its complete established presentation rather than guessing a control.
  if (!triggerSupported) return choice.blocked ? <Button type="button" variant="ghost" onClick={() => choice.requestOpen(false)}>Restore controls</Button> : <span aria-busy="true" />;
  const authored = trigger ?? <Button type="button" size="icon" variant="ghost" aria-label={label} data-testid={testId}
    className="h-11 w-11 rounded-full text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] hover:text-[color:var(--app-accent-hover)]">
    {Icon ? <Icon className="h-[21px] w-[21px]" aria-hidden="true" /> : label}
  </Button>;
  return <Slot ref={triggerRef} aria-haspopup="dialog" aria-expanded={choice.presented}
    data-native-owned-choice={choice.blocked ? "blocked" : choice.presented ? "presented" : "ready"}
    onClick={(event) => {
      if (event.defaultPrevented || triggerRef.current?.disabled) return;
      event.preventDefault();
      choice.requestOpen(true);
    }}>{authored}</Slot>;
}
