"use client";
import { useRef, useState } from "react";
import {
  ChevronRight,
  LogOut,
  KeyRound,
  Plus,
  MoreHorizontal,
  Trash2,
} from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import styles from "../connect-workspace.module.css";

/** Gesture presentation only: swiping reveals the same confirmed action as Options. */
export function ConnectCircleRow({
  title,
  description,
  testId,
  action,
  onOpen,
  onDestructive,
}: {
  title: string;
  description: string;
  testId: string;
  action: "delete" | "leave" | null;
  onOpen: () => void;
  onDestructive: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    offset: number;
    moved: boolean;
  } | null>(null);
  const ignoreClick = useRef(false);
  const label = action === "delete" ? "Delete" : "Leave";
  const settle = (next: boolean) => {
    if (rowRef.current) {
      rowRef.current.style.transition = "";
      rowRef.current.style.transform = `translateX(${next ? -92 : 0}px)`;
    }
    setRevealed(next);
  };
  return (
    <div
      className={styles.swipeRow}
      data-swipe-views-horizontal-scroll=""
      style={{ touchAction: "pan-y" }}
      onPointerDown={(event) => {
        if (action && event.button === 0) {
          ignoreClick.current = false;
          gesture.current = {
            x: event.clientX,
            y: event.clientY,
            offset: revealed ? -92 : 0,
            moved: false,
          };
        }
      }}
      onPointerMove={(event) => {
        const start = gesture.current;
        if (!start || !rowRef.current) return;
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y;
        if (!start.moved && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          gesture.current = null;
          return;
        }
        if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          start.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        if (!start.moved) return;
        start.offset = Math.max(-92, Math.min(0, (revealed ? -92 : 0) + dx));
        rowRef.current.style.transition = "none";
        rowRef.current.style.transform = `translateX(${start.offset}px)`;
      }}
      onPointerUp={(event) => {
        const start = gesture.current;
        if (start?.moved) {
          ignoreClick.current = true;
          settle(start.offset < -36);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        gesture.current = null;
      }}
      onPointerCancel={() => {
        gesture.current = null;
        ignoreClick.current = false;
        settle(revealed);
      }}
      onClickCapture={(event) => {
        if (ignoreClick.current) {
          event.preventDefault();
          event.stopPropagation();
          ignoreClick.current = false;
        }
      }}
    >
      {action ? (
        <button
          type="button"
          className={styles.swipeAction}
          aria-label={`${label} ${title}`}
          aria-hidden={!revealed}
          tabIndex={revealed ? 0 : -1}
          onClick={onDestructive}
        >
          {action === "delete" ? (
            <Trash2 aria-hidden="true" className="size-4" />
          ) : (
            <LogOut aria-hidden="true" className="size-4" />
          )}
          {label}
        </button>
      ) : null}
      <div ref={rowRef} className={styles.circleRow}>
        <button
          type="button"
          className={styles.circleOpen}
          data-testid={testId}
          aria-label={`Open ${title} circle, ${description}`}
          onClick={() => (revealed ? settle(false) : onOpen())}
        >
          <span>
            <strong>{title}</strong>
            <small>{description}</small>
          </span>
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="icon-touch"
              aria-label={`Options for ${title}`}
            >
              <MoreHorizontal aria-hidden="true" className="size-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-52 flex-col gap-1 p-1">
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="compact"
              className="min-h-11 w-full justify-start"
              onClick={onOpen}
            >
              Open circle
            </Button>
            {action ? (
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="compact"
                className="min-h-11 w-full justify-start text-destructive"
                onClick={onDestructive}
              >
                {label} circle
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="none"
          effect="fade"
          size="icon-touch"
          aria-label={`Open ${title}`}
          onClick={onOpen}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Shared presentation for the existing Create/Join entry points. */
export function ConnectCircleHeading({
  title,
  count,
  action,
  onAction,
}: {
  title: string;
  count?: number;
  action: "create" | "join";
  onAction: () => void;
}) {
  const create = action === "create";
  return (
    <div className={styles.circleHeading}>
      <h2>
        {title}
        {count !== undefined ? (
          <>
            {" "}
            <span className={styles.count}>{count}</span>
          </>
        ) : null}
      </h2>
      <Button
        type="button"
        variant={create ? "blue" : "none"}
        effect={create ? "fill" : "fade"}
        size="compact"
        className={create ? "min-h-11 rounded-full" : styles.utilityAction}
        onClick={onAction}
        data-testid={`connect-circle-${action}`}
      >
        {create ? (
          <Plus aria-hidden="true" className="mr-1.5 size-4" />
        ) : (
          <KeyRound aria-hidden="true" className="size-4" />
        )}
        {create ? "Create circle" : "Join with code"}
      </Button>
    </div>
  );
}
