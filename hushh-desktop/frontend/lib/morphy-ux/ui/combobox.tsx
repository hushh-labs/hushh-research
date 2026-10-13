"use client";

/**
 * Morphy Combobox Extension
 *
 * Rule:
 * - `components/ui/*` must remain stock shadcn (vendor code).
 * - Any app-specific behavior, styling, or bug fixes must live here.
 *
 * This file provides a stable import path for feature code:
 *   import { Combobox, ... } from "@/lib/morphy-ux/ui/combobox";
 */

import * as React from "react";

import {
  Combobox as StockCombobox,
  ComboboxCollection as StockComboboxCollection,
  ComboboxContent as StockComboboxContent,
  ComboboxEmpty as StockComboboxEmpty,
  ComboboxGroup as StockComboboxGroup,
  ComboboxInput as StockComboboxInput,
  ComboboxItem as StockComboboxItem,
  ComboboxList as StockComboboxList,
  ComboboxValue as StockComboboxValue,
} from "@/components/ui/combobox";

export const Combobox = StockCombobox;
export const ComboboxCollection = StockComboboxCollection;
export const ComboboxContent = StockComboboxContent;
export const ComboboxEmpty = StockComboboxEmpty;
export const ComboboxGroup = StockComboboxGroup;
export const ComboboxInput = StockComboboxInput;
export const ComboboxList = StockComboboxList;
export const ComboboxValue = StockComboboxValue;

function ensureMorphyComboboxStyles() {
  if (typeof document === "undefined") return;

  const id = "morphy-combobox-overrides";
  if (document.getElementById(id)) return;

  const style = document.createElement("style");
  style.id = id;
  style.textContent = [
    // Hide the stock shadcn/Base UI item indicator (checkmark).
    "[data-slot='combobox-item-indicator']{display:none!important}",
    // Ensure list items are actually tappable/clickable.
    // Base UI uses pointer events + press handling; on some mobile stacks the default
    // `cursor-default` can combine with overlays to make taps feel dead.
    "[data-slot='combobox-item']{cursor:pointer}",
    // Keep the trigger chevron contrast-correct by inheriting the host button color.
    // This avoids muted gray icons disappearing on stronger hover/fill surfaces.
    "[data-slot='combobox-trigger-icon']{color:currentColor!important;opacity:.72;transition:opacity 160ms ease,color 160ms ease}",
    "[data-slot='button']:hover [data-slot='combobox-trigger-icon'],[data-slot='button']:focus-visible [data-slot='combobox-trigger-icon'],[data-slot='button'][data-state='open'] [data-slot='combobox-trigger-icon'],[data-slot='button'][data-pressed] [data-slot='combobox-trigger-icon']{opacity:1}",
  ].join("\n");

  document.head.appendChild(style);
}

/**
 * Morphy override:
 * - hide the stock shadcn/Base UI item indicator (checkmark)
 * - ensure pointer/tap selects items reliably
 */
export function ComboboxItem(
  props: React.ComponentProps<typeof StockComboboxItem>
) {
  ensureMorphyComboboxStyles();

  return (
    <StockComboboxItem
      {...props}
      // Stock ComboboxItem uses `cursor-default`; override to `cursor-pointer`.
      className={props.className}
      // Hide indicator by removing its reserved space.
      style={{
        ...(props.style ?? {}),
        ["--combobox-item-indicator-width" as any]: "0px",
      }}
      // Mobile Safari sometimes fails to trigger selection when the press starts on
      // nested elements; forcing the press to begin on the item helps.
      onPointerDown={(e) => {
        props.onPointerDown?.(e as any);
        // Don't prevent default; just ensure the item receives focus/press.
        (e.currentTarget as HTMLElement).focus?.();
      }}
    />
  );
}

export type ComboboxProps = React.ComponentProps<typeof StockCombobox>;
