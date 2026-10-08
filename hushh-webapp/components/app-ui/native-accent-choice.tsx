"use client";

import { useRef } from "react";
import { NativeChatChrome } from "@/components/app-ui/native-chat-chrome";
import { SHELL_ICON_BUTTON_CLASSNAME } from "@/components/app-ui/shell-action-surface";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { writeAccent, type AppAccent } from "@/lib/theme/accent";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

/** Public preference projection only; the existing accent service owns commits. */
export function NativeAccentChoice({ value, owner, context, eligible }: {
  value: AppAccent; owner: string | null; context: string; eligible: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="flex min-w-0 items-center justify-end gap-2">
    <span className="text-sm text-muted-foreground">{value === "gold" ? "Molten Gold" : "iOS Blue"}</span>
    <NativeChatChrome kind="accent" value={value} onValueChange={writeAccent}
      owner={owner} context={context} eligible={eligible} focusRef={trigger}
      className="flex size-11 shrink-0 items-center justify-center">
      <Select value={value} onValueChange={(next) => { if (next === "blue" || next === "gold") writeAccent(next); }}>
        <SelectTrigger ref={trigger} aria-label="App accent color"
          className={cn(SHELL_ICON_BUTTON_CLASSNAME, "size-11 justify-center gap-1 px-0 data-[size=default]:h-11")}>
          <span aria-hidden className="size-3 shrink-0 rounded-full bg-[color:var(--app-accent)]" />
          <MaterialRipple variant="blue" effect="glass" className="z-10" />
        </SelectTrigger>
        <SelectContent><SelectItem value="blue">iOS Blue</SelectItem><SelectItem value="gold">Molten Gold</SelectItem></SelectContent>
      </Select>
    </NativeChatChrome>
  </div>;
}
