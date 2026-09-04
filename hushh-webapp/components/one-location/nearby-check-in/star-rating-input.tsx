"use client";

/**
 * A 1-5 star input.
 *
 * Lives here rather than in `components/ui/` for two reasons. Every file in
 * that directory is a near-verbatim shadcn primitive and this would be the
 * first bespoke one with a single consumer; and nothing under `components/ui/`
 * matches any targeted CI pack, so a change to it would run no tests at all.
 * When the ratings history screen needs a read-only star display, the shared
 * shape will be knowable and this moves to `components/ui/rating.tsx` with
 * both consumers in hand.
 *
 * Built on `RadioGroupPrimitive` directly rather than on `RadioGroupItem`,
 * which hardcodes `size-4` and a `CircleIcon` indicator -- both would have to
 * be fought. The focus ring is copied verbatim from `radio-group.tsx` so focus
 * looks identical to every other radio in the app.
 */

import { Star } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import {
  CHECK_IN_STAR_GLYPH_OFF_CLASSNAME,
  CHECK_IN_STAR_GLYPH_ON_CLASSNAME,
  CHECK_IN_STAR_ROW_CLASSNAME,
  CHECK_IN_STAR_TARGET_CLASSNAME,
} from "@/components/one-location/nearby-check-in/check-in-panel-layout";
import { cn } from "@/lib/utils";

export const STAR_RATING_VALUES = [1, 2, 3, 4, 5] as const;

export type StarRatingValue = (typeof STAR_RATING_VALUES)[number];

/**
 * One word per star.
 *
 * A bare 1-5 scale means different things to two different people; the
 * adjective is what makes a 3 the same 3 twice. It sits in a fixed-width span
 * so a longer word cannot reflow the star row under it.
 */
export const STAR_RATING_ADJECTIVES: Record<StarRatingValue, string> = {
  1: "Poor",
  2: "Fair",
  3: "Okay",
  4: "Good",
  5: "Great",
};

function starLabel(value: StarRatingValue): string {
  return value === 1 ? "1 star" : `${value} stars`;
}

export function StarRatingInput({
  value,
  onChange,
  disabled = false,
  labelledBy,
}: {
  value: StarRatingValue | null;
  onChange: (value: StarRatingValue) => void;
  disabled?: boolean;
  /** Id of the visible question, so the group announces as that question
   *  rather than as an unnamed set of five radios. */
  labelledBy?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <RadioGroupPrimitive.Root
        // ArrowRight at 5 must stop, not wrap round to 1. A rating that
        // silently becomes a 1 on one extra press is a real mis-set, and the
        // control offers no way to notice it happened.
        loop={false}
        disabled={disabled}
        aria-labelledby={labelledBy}
        value={value ? String(value) : undefined}
        onValueChange={(next) => onChange(Number(next) as StarRatingValue)}
        className={CHECK_IN_STAR_ROW_CLASSNAME}
        data-testid="check-in-star-rating"
      >
        {STAR_RATING_VALUES.map((star) => {
          const filled = value !== null && star <= value;
          return (
            <RadioGroupPrimitive.Item
              key={star}
              value={String(star)}
              aria-label={starLabel(star)}
              className={CHECK_IN_STAR_TARGET_CLASSNAME}
            >
              <Star
                aria-hidden="true"
                className={cn(
                  filled
                    ? CHECK_IN_STAR_GLYPH_ON_CLASSNAME
                    : CHECK_IN_STAR_GLYPH_OFF_CLASSNAME,
                  // Feedback only, at the press. 120ms on transform alone:
                  // fast enough to read as the control responding rather than
                  // as an animation, and it never touches layout.
                  "transition-transform duration-[120ms] ease-[cubic-bezier(0.23,1,0.32,1)]",
                  "active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100",
                )}
              />
            </RadioGroupPrimitive.Item>
          );
        })}
      </RadioGroupPrimitive.Root>

      {/* Radix announces the item on focus, but a VoiceOver double-tap reads
          only that item's label -- and the adjective is not in it. */}
      <span
        aria-live="polite"
        className="w-12 shrink-0 text-right text-[13px] font-medium leading-4 text-muted-foreground"
      >
        {value ? STAR_RATING_ADJECTIVES[value] : ""}
      </span>
    </div>
  );
}
