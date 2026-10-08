"use client";

import { useRef } from "react";
import { NativeChatChrome } from "@/components/app-ui/native-chat-chrome";
import { SHELL_PILL_TRIGGER_CLASSNAME } from "@/components/app-ui/shell-action-surface";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { writeAccent, type AppAccent } from "@/lib/theme/accent";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

/** Public preference projection only; the existing accent service owns commits. */
export function NativeAccentChoice({ value, owner, context, eligible }: {
  value: AppAccent; owner: string | null; context: string; eligible: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <NativeChatChrome kind="accent" value={value} onValueChange={writeAccent}
      owner={owner} context={context} eligible={eligible} focusRef={trigger}
      className="flex h-11 w-[172px] min-w-0 shrink-0 items-center justify-center">
      <Select value={value} onValueChange={(next) => { if (next === "blue" || next === "gold") writeAccent(next); }}>
        <SelectTrigger ref={trigger} aria-label="App accent color"
          className={cn(SHELL_PILL_TRIGGER_CLASSNAME, "h-11 w-[172px] justify-between gap-2 px-3 data-[size=default]:h-11")}>
          <span aria-hidden className="size-3 shrink-0 rounded-full bg-[color:var(--app-accent)]" />
          <span>{value === "gold" ? "Molten Gold" : "iOS Blue"}</span>
          <MaterialRipple variant="none" effect="fade" className="z-10" />
        </SelectTrigger>
        <SelectContent><SelectItem value="blue">iOS Blue</SelectItem><SelectItem value="gold">Molten Gold</SelectItem></SelectContent>
      </Select>
    </NativeChatChrome>;
}
