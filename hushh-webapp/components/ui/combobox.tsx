"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

// Export Root directly
export const Combobox = ComboboxPrimitive.Root;

// --- Value & Trigger ---
export function ComboboxValue({
  children,
  placeholder,
}: ComboboxPrimitive.Value.Props) {
  return (
    <ComboboxPrimitive.Value
      data-slot="combobox-value"
      placeholder={placeholder}
    >
      {children}
    </ComboboxPrimitive.Value>
  );
}

export function ComboboxTrigger({
  className,
  children,
  id,
  style,
  disabled,
  onClick,
  onFocus,
  onBlur,
}: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("[&_svg]:size-4", className)}
      id={id}
      style={style}
      disabled={disabled}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {children}
      <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4" />
    </ComboboxPrimitive.Trigger>
  );
}

// --- Input & Addons ---
export function ComboboxInput({
  className,
  disabled = false,
  showTrigger = true,
  showClear = false,
  value,
  onChange,
  placeholder,
  autoFocus,
  onFocus,
  onBlur,
  onKeyDown,
  onKeyUp,
  id,
  name,
}: ComboboxPrimitive.Input.Props & { showTrigger?: boolean; showClear?: boolean }) {
  return (
    <InputGroup className={cn("w-full", className)}>
      <ComboboxPrimitive.Input
        render={<InputGroupInput disabled={disabled} />}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        id={id}
        name={name}
      />
      <InputGroupAddon align="inline-end">
        {showTrigger && (
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            asChild
            disabled={disabled}
            className="group-has-data-[slot=combobox-clear]:hidden"
          >
            <ComboboxTrigger />
          </InputGroupButton>
        )}
        {showClear && <ComboboxClear disabled={disabled} />}
      </InputGroupAddon>
    </InputGroup>
  );
}

// --- Content & Popups ---
export function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  children,
  style,
  id,
}: ComboboxPrimitive.Popup.Props & { side?: "top" | "bottom"; sideOffset?: number; align?: "start" | "end" }) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-50 w-(--anchor-width)"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 rounded-md border shadow-md p-1",
            className
          )}
          style={style}
          id={id}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

// --- Items & Lists ---
export function ComboboxItem({
  className,
  children,
  value,
  disabled,
  style,
  onClick,
  onPointerDown,
  onKeyDown,
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      value={value}
      disabled={disabled}
      style={style}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none",
        className
      )}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
        <CheckIcon className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

// Helper: Clear Action
function ComboboxClear({
  className,
  disabled,
  onClick,
}: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      render={<InputGroupButton variant="ghost" size="icon-xs" />}
      className={cn(className)}
      disabled={disabled}
      onClick={onClick}
    >
      <XIcon />
    </ComboboxPrimitive.Clear>
  );
}

// --- Standard Exports ---
export const ComboboxList = ComboboxPrimitive.List;
export const ComboboxGroup = ComboboxPrimitive.Group;
export const ComboboxLabel = ComboboxPrimitive.GroupLabel;
export const ComboboxEmpty = ComboboxPrimitive.Empty;
export const ComboboxSeparator = ComboboxPrimitive.Separator;
export const ComboboxCollection = ComboboxPrimitive.Collection;