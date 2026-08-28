import { cn } from "@/lib/utils";

/**
 * The SMS Circle's identity mark: a filled red disc reading "SMS".
 *
 * WHY THIS IS A MODULE AND NOT TWO CLASS STRINGS
 *
 * The same Circle is listed on two surfaces. Location's People tab lists it
 * (`redesign/circles/named-circle-flows.tsx`) because that is where the SOS
 * roster is used, and Connect lists it (`connect/circles/connect-circles-tab.tsx`)
 * because issue #5458 moved what a Circle *is* under Connect. Location drew
 * this mark; Connect drew a `Siren` glyph in the same indigo utility well it
 * gives Trusted and every user-made Circle -- so the one row on the list whose
 * whole point is that it behaves differently in an emergency looked like all
 * the others, and the two surfaces disagreed about what the same Circle is.
 *
 * Red is the identity, not a decoration: it is the only Circle that sends a
 * message on your behalf when you are in trouble. `#FF3B30` is the same value
 * every other destructive/emergency affordance on Location uses (the SOS
 * controls in `redesign/location-redesign-hub.tsx`, `redesign/share-lanes.tsx`).
 *
 * A single component rather than an exported class string because the two
 * surfaces render at different densities and a bare string cannot carry that:
 * see `size` below.
 */

/** Kept as the Location list's original test id so its contract test, and any
 *  selector already written against that surface, still resolve. */
export const CIRCLE_SMS_MARK_TESTID = "one-location-circle-sms-mark";

/**
 * Which row rhythm the mark is sitting in.
 *
 * `md` (36px) is Location's People tab, whose circle rows are 60px tall with
 * their own padding overrides. `sm` (28px) is a `SettingsRow density="compact"`
 * icon well, which is what Connect's Circles list uses -- dropping a 36px mark
 * into that list would make the SMS row taller than its neighbours and push it
 * past the 58px inset the compact separator hairline is drawn at.
 *
 * The type scales with the disc (11/36 == 9/28) so the letterforms sit the same
 * way inside the circle at either size; "SMS" at 9px measures ~19px against a
 * ~27px chord at the cap line, so it is nowhere near the edge.
 */
export type CircleSmsMarkSize = "sm" | "md";

const CIRCLE_SMS_MARK_SIZE_CLASSNAME: Record<CircleSmsMarkSize, string> = {
  sm: "h-7 w-7 text-[9px]",
  md: "h-9 w-9 text-[11px]",
};

/**
 * No dark-mode variant, deliberately.
 *
 * The neutral mark beside it does flip, because a light grey well disappears on
 * a dark sheet. This one is a filled colour chip with white letters on it: it
 * has the same contrast in both themes, and dimming it in dark mode would take
 * the alarm out of the only row on the list that is an alarm.
 */
export function CircleSmsMark({
  size = "md",
  className,
  testId = CIRCLE_SMS_MARK_TESTID,
}: {
  size?: CircleSmsMarkSize;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-circle-mark="sms"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full bg-[#FF3B30] font-bold leading-none tracking-[-0.2px] text-white",
        CIRCLE_SMS_MARK_SIZE_CLASSNAME[size],
        className,
      )}
    >
      SMS
    </span>
  );
}
