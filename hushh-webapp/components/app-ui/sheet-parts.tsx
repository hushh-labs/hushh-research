"use client";

import * as React from "react";
import { Search, X } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { SEARCH_INPUT_KEYBOARD_PROPS } from "./search-input-keyboard";
import { cn } from "@/lib/utils";
import styles from "./sheet-parts.module.css";

/** Controlled presentation: query ownership and filtering stay with the feature. */
export function SheetSearch({ value, onValueChange, label = "Search connections", className, ...props }:
  Omit<React.ComponentProps<"input">, "value" | "onChange" | "size"> & {
    value: string; onValueChange: (value: string) => void; label?: string;
  }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <InputGroup className={cn(styles.search, className)}>
      <InputGroupAddon><Search aria-hidden="true" className="size-4" /></InputGroupAddon>
      <InputGroupInput {...SEARCH_INPUT_KEYBOARD_PROPS} {...props} ref={inputRef} type="search" value={value} aria-label={label}
        onChange={event => onValueChange(event.target.value)} />
      {value ? <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-sm" className={styles.clear} disabled={props.disabled} aria-label="Clear search"
          onClick={() => { onValueChange(""); inputRef.current?.focus(); }}><X aria-hidden="true" className="size-4" /></InputGroupButton>
      </InputGroupAddon> : null}
    </InputGroup>
  );
}

export function SheetCount({ className, ...props }: React.ComponentProps<"span">) {
  return <span {...props} className={cn(styles.count, className)} role="status" aria-live="polite" aria-atomic="true" />;
}

export function SheetActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div {...props} className={cn(styles.actions, className)} />;
}

export function SheetPersonRow({ avatar, name, detail, checked, disabled, onCheckedChange, label } : {
  avatar: React.ReactNode; name: string; detail?: string; checked: boolean; disabled?: boolean;
  onCheckedChange: (checked: boolean) => void; label: string;
}) {
  const detailId = React.useId();
  return <label className={styles.person} data-selected={checked} data-disabled={disabled || undefined}>
    {avatar}
    <span className={styles.personLabel}><span className={styles.personName} dir="auto">{name}</span>
      {detail ? <span id={detailId} className={styles.personDetail} dir="auto">{detail}</span> : null}</span>
    <Checkbox className={styles.check} checked={checked} disabled={disabled} aria-label={label}
      aria-describedby={detail ? detailId : undefined}
      onCheckedChange={value => onCheckedChange(value === true)} />
  </label>;
}

export { styles as sheetPartStyles };
