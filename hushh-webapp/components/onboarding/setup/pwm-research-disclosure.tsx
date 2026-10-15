import { cn } from "@/lib/utils";

/**
 * Research and its ready email are on by default: the server enrolls the owner
 * on the first ensure after setup. This is the disclosure, not a choice; both
 * switches live in Personal World Model. Every surface that completes setup
 * renders it directly above its final action.
 */
export const PWM_RESEARCH_DISCLOSURE =
  "Your private agent will look up public information about you to prepare your Personal World Model, and email you when it's ready. You review everything before it's saved, and you can turn either off anytime in Personal World Model.";

export function PwmResearchDisclosure({ className }: { className?: string }) {
  return (
    <p
      className={cn("text-xs text-muted-foreground", className)}
      data-testid="pwm-research-disclosure"
    >
      {PWM_RESEARCH_DISCLOSURE}
    </p>
  );
}
