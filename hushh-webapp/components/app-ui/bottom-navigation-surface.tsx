"use client";

import { SegmentedPill, type SegmentedPillOption } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

/** One visual slot. The existing Navbar owns navigation and native admission. */
export function BottomNavigationSurface({ native, value, options, onValueChange }: {
  native: { ready: boolean; reserved?: boolean; height: number };
  value: string;
  options: SegmentedPillOption[];
  onValueChange: (value: string) => void;
}) {
  if (native.reserved ?? native.ready) return <div aria-hidden="true" data-native-navigation-reservation
    className="w-full pointer-events-none" style={{ height: native.height }} />;
  return <div className="w-full min-w-0 pointer-events-auto">
    <SegmentedPill hapticFeedback={false} size="compact" layout="stacked" hitArea="segment" ripple={false}
      value={value} options={options} onValueChange={onValueChange} ariaLabel="Route navigation"
      className={cn(
        "kai-bottom-nav-pill relative z-10 w-full chrome-bottom-foreground",
        "[&_[role=radio]]:min-h-11",
        "[&_[aria-checked=true]]:text-[color:var(--app-accent)] [&_[aria-checked=true]]:font-medium [&_[aria-checked=true]]:bg-foreground/[0.06]",
        "[&_[role=radio]>span:last-of-type]:!text-[11px] [&_[role=radio]>span:last-of-type]:!leading-[13px]",
        "[&_[data-segment-indicator]]:bg-transparent [&_[data-segment-indicator]]:shadow-none [&_[data-segment-indicator]]:backdrop-blur-none",
      )} />
  </div>;
}
