"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Trash2, Undo2 } from "@/components/icons";

import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type HoldingRowActionsProps = {
  symbol?: string;
  isDeleted?: boolean;
  disableEdit?: boolean;
  onEdit: () => void;
  onToggleDelete: () => void;
  layout?: "icon" | "row";
  className?: string;
};

export function HoldingRowActions({
  symbol,
  isDeleted = false,
  disableEdit = false,
  onEdit,
  onToggleDelete,
  layout = "icon",
  className,
}: HoldingRowActionsProps) {
  const normalizedSymbol = symbol || "holding";
  const [menuOpen, setMenuOpen] = useState(false);
  const dismissedByScroll = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const dismissOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      if (target === document || target === window ||
        (target instanceof Element && target.contains(triggerRef.current))) {
        dismissedByScroll.current = true;
        setMenuOpen(false);
      }
    };
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => window.removeEventListener("scroll", dismissOnScroll, true);
  }, [menuOpen]);

  if (layout === "row") {
    return (
      <div
        className={cn(
          "flex w-full items-center justify-start",
          className
        )}
      >
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <MorphyButton
              ref={triggerRef}
              variant="none"
              effect="fade"
              size="sm"
              aria-label={`Holding actions for ${normalizedSymbol}`}
              title={`Actions for ${normalizedSymbol}`}
              className="h-7 w-7 min-w-7 justify-center p-0"
            >
              <Icon icon={MoreHorizontal} size="sm" />
            </MorphyButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            ref={menuRef}
            align="start"
            sideOffset={6}
            onCloseAutoFocus={(event) => {
              if (dismissedByScroll.current) event.preventDefault();
              dismissedByScroll.current = false;
            }}
          >
            <DropdownMenuItem
              disabled={disableEdit}
              onSelect={() => {
                setMenuOpen(false);
                if (!disableEdit) onEdit();
              }}
            >
              <Icon icon={Pencil} size="sm" className="mr-2" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className={cn(!isDeleted && "text-rose-600 focus:text-rose-600")}
              onSelect={() => {
                setMenuOpen(false);
                onToggleDelete();
              }}
            >
              <Icon icon={isDeleted ? Undo2 : Trash2} size="sm" className="mr-2" />
              {isDeleted ? "Restore" : "Delete"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center justify-end gap-1", className)}>
      <MorphyButton
        variant="none"
        effect="fade"
        size="sm"
        disabled={disableEdit}
        aria-label={`Edit ${normalizedSymbol}`}
        onClick={onEdit}
        title={`Edit ${normalizedSymbol}`}
        className="h-8 w-8 min-w-8 justify-center p-0"
      >
        <Icon icon={Pencil} size="sm" />
      </MorphyButton>

      <MorphyButton
        variant="none"
        effect="fade"
        size="sm"
        aria-label={isDeleted ? `Undo remove ${normalizedSymbol}` : `Remove ${normalizedSymbol}`}
        onClick={onToggleDelete}
        title={isDeleted ? `Restore ${normalizedSymbol}` : `Remove ${normalizedSymbol}`}
        className={cn(
          "h-8 w-8 min-w-8 justify-center p-0",
          isDeleted ? "text-muted-foreground" : "text-rose-600 hover:text-rose-700"
        )}
      >
        <Icon icon={isDeleted ? Undo2 : Trash2} size="sm" />
      </MorphyButton>
    </div>
  );
}
