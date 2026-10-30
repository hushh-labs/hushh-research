"use client";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export const QUICK_MESSAGE_REACTIONS = ["❤️", "😂", "😮", "😢", "👍", "🙏"] as const;

/** Message reactions share the same touch targets and menu keyboard behavior. */
export function MessageReactionMenu({ onSelect, disabled = false }: {
  onSelect: (emoji: string) => void;
  disabled?: boolean;
}) {
  return <div role="group" aria-label="Quick reactions" className="grid w-[264px] grid-cols-6 border-b border-border/60 pb-1">
    {QUICK_MESSAGE_REACTIONS.map((emoji) => <DropdownMenuItem key={emoji}
      aria-label={`React ${emoji}`} disabled={disabled}
      className="flex size-11 min-h-11 justify-center p-0 text-xl leading-none"
      onSelect={() => onSelect(emoji)}><span aria-hidden="true">{emoji}</span></DropdownMenuItem>)}
  </div>;
}
