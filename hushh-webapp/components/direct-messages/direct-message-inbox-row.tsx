"use client";

import { useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Trash2 } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLongPress } from "@/lib/morphy-ux/hooks/use-long-press";
import styles from "./direct-messages-page.module.css";

export function DirectMessageInboxRow({ label, active, disabled, onOpen, onDelete, children }: {
  label: string;
  active: boolean;
  disabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const held = useRef(false);
  const hold = useLongPress(disabled || menuOpen, true);
  return <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
    <div className={styles.conversationItem} role="group" aria-label={`${label} chat`}>
      <button type="button" className={styles.conversationRow} data-active={active ? "true" : undefined}
        disabled={disabled}
        onPointerDown={(event) => {
          held.current = false;
          hold.start(event, () => { held.current = true; setMenuOpen(true); });
        }}
        onPointerMove={hold.move} onPointerUp={hold.cancel} onPointerCancel={hold.cancel} onPointerLeave={hold.cancel}
        onContextMenu={(event) => { event.preventDefault(); hold.cancel(); if (!disabled) { held.current = true; setMenuOpen(true); } }}
        onClick={(event) => {
          if (held.current && event.detail !== 0) { event.preventDefault(); held.current = false; return; }
          onOpen();
        }}>
        {children}
      </button>
      <DropdownMenuTrigger asChild>
        <button type="button" className={styles.conversationOptions} aria-label="Chat options" disabled={disabled}>
          <MoreHorizontal className="size-5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
    </div>
    <DropdownMenuContent align="end" data-messages-type-scale>
      <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={onDelete}>
        <Trash2 className="size-4" aria-hidden="true" /> Delete chat
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
