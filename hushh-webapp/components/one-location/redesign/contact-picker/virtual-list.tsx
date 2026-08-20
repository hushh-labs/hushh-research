"use client";

import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  CONTACT_ROW_HEIGHT_PX,
  ContactGroup,
} from "@/components/one-location/redesign/contact-picker/atoms";
import { shouldVirtualizeList } from "@/lib/one-location/contact-picker-controls";
import { cn } from "@/lib/utils";

/**
 * One list component for every roster in the picker.
 *
 * Windowing engages on exactly the same threshold that reveals the search
 * controls, and for two reasons that happen to agree:
 *
 *   * A virtualizer measuring three rows costs more than it saves.
 *   * jsdom reports every element as 0px tall, so a virtualized list renders
 *     almost nothing under test. Below the threshold the rows are plain DOM,
 *     which keeps small fixtures directly assertable — and the windowing that
 *     matters at 100 contacts still engages exactly where it is needed.
 *
 * Above the threshold the scroll container is capped so the page keeps ONE
 * scrolling surface per tab rather than nesting a tall inner scroller inside
 * an equally tall outer one.
 */
export function VirtualContactList<T>({
  items,
  getKey,
  renderItem,
  maxHeightClassName = "max-h-[52vh]",
  testId,
  ariaLabel,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  maxHeightClassName?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualize = shouldVirtualizeList(items.length);

  const virtualizer = useVirtualizer({
    count: virtualize ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CONTACT_ROW_HEIGHT_PX,
    // Five rows of runway on each side: enough that a fast flick never shows
    // blank space, small enough that a 100-person list still mounts ~15 rows.
    overscan: 5,
    getItemKey: (index) => getKey(items[index] as T),
  });

  if (!virtualize) {
    return (
      <ContactGroup>
        <div data-testid={testId} aria-label={ariaLabel} role={ariaLabel ? "list" : undefined}>
          {items.map((item) => (
            <div key={getKey(item)} role={ariaLabel ? "listitem" : undefined}>
              {renderItem(item)}
            </div>
          ))}
        </div>
      </ContactGroup>
    );
  }

  return (
    <ContactGroup>
      <div
        ref={scrollRef}
        data-testid={testId}
        data-virtualized="true"
        aria-label={ariaLabel}
        role={ariaLabel ? "list" : undefined}
        className={cn(
          "overflow-y-auto overscroll-contain",
          // Momentum scrolling in the Capacitor webview; without it a long
          // roster scrolls with a dead, non-native feel on iOS.
          "[-webkit-overflow-scrolling:touch]",
          maxHeightClassName,
        )}
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index] as T;
            return (
              <div
                key={virtualItem.key}
                // Measured rather than assumed: a name that wraps to two lines
                // is taller than the estimate, and an unmeasured window drifts
                // out of register with its own scrollbar over 100 rows.
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                role={ariaLabel ? "listitem" : undefined}
                className="absolute left-0 top-0 w-full border-b border-[color:var(--app-separator)] last:border-b-0"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {renderItem(item)}
              </div>
            );
          })}
        </div>
      </div>
    </ContactGroup>
  );
}
