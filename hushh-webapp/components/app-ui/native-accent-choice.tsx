"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ChromeAccentPalette } from "@/lib/capacitor/native-chrome";
import { NativeChatChrome } from "@/components/app-ui/native-chat-chrome";
import { SHELL_ICON_BUTTON_CLASSNAME } from "@/components/app-ui/shell-action-surface";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { writeAccent, type AppAccent } from "@/lib/theme/accent";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

function readAccentPalette(): ChromeAccentPalette | undefined {
  if (typeof document === "undefined") return undefined;
  const style = getComputedStyle(document.documentElement);
  const blue = style.getPropertyValue("--accent-preview-blue").trim();
  const gold = style.getPropertyValue("--accent-preview-gold").trim();
  return [blue, gold].every(color => /^#[0-9a-f]{6}$/i.test(color)) ? { blue, gold } : undefined;
}

/** Public preference projection only; the existing accent service owns commits. */
export function NativeAccentChoice({ value, owner, context, eligible }: {
  value: AppAccent; owner: string | null; context: string; eligible: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  // A warm document already has its palette. Do not first admit the fallback
  // and then replace it solely because this route mounted its preference row.
  const [palette, setPalette] = useState(readAccentPalette);
  useLayoutEffect(() => {
    setPalette(current => current ?? readAccentPalette());
  }, []);
  const label = value === "gold" ? "Molten Gold" : "Blue";
  return <div className="flex min-w-0 items-center justify-end">
    <NativeChatChrome kind="accent" value={value} onValueChange={writeAccent}
      fullTrigger palette={palette} owner={owner} context={context} eligible={eligible && !!palette} focusRef={trigger}
      className="flex h-11 w-[180px] max-w-full shrink-0 items-center justify-center [&>div]:w-full">
      <Select value={value} onValueChange={(next) => { if (next === "blue" || next === "gold") writeAccent(next); }}>
        <SelectTrigger ref={trigger} aria-label="App accent color"
          className={cn(SHELL_ICON_BUTTON_CLASSNAME, "h-11 w-full justify-between gap-2 px-3 data-[size=default]:h-11")}>
          <span aria-hidden className="size-3 shrink-0 rounded-full bg-[color:var(--app-accent)]" />
          <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
          <MaterialRipple variant="blue" effect="glass" className="z-10" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="blue"><span aria-hidden className="inline-block size-3 shrink-0 rounded-full bg-[color:var(--accent-preview-blue)] ring-1 ring-foreground/40" /> Blue</SelectItem>
          <SelectItem value="gold"><span aria-hidden className="inline-block size-3 shrink-0 rounded-full bg-[color:var(--accent-preview-gold)] ring-1 ring-foreground/40" /> Molten Gold</SelectItem>
        </SelectContent>
      </Select>
    </NativeChatChrome>
  </div>;
}
