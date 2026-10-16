import { cn } from "@/lib/utils";

/**
 * Research and its ready email are on by default: the server enrolls the owner
 * on the first ensure after setup. This is the disclosure, not a choice; both
 * switches live in Personal World Model. Every surface that completes setup
 * renders it directly above its final action.
 */
export const PWM_RESEARCH_DISCLOSURE =
  "Your private agent will look up public information about you to prepare your Personal World Model, and email you when it's ready. You review everything before it's saved, and you can turn either off anytime in Personal World Model.";

export const PWM_RESEARCH_DISCLOSURE_COMPACT =
  "One uses public info for your Personal World Model and emails you when ready. Review before saving; turn either off anytime.";

export function PwmResearchDisclosure({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <p
      className={cn("text-xs text-muted-foreground", className)}
      data-testid="pwm-research-disclosure"
    >
      {compact ? PWM_RESEARCH_DISCLOSURE_COMPACT : PWM_RESEARCH_DISCLOSURE}
    </p>
  );
}
