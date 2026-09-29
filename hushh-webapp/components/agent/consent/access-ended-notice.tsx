/**
 * The calm "Access ended" state (contract C3 redaction, part b).
 *
 * Rendered in place of anything derived from a bundle whose access was
 * revoked or ran out: the card's shared details here, and (lane C2) every
 * assistant message tagged with that bundle. It carries no shared values by
 * construction; callers pass only the person's name and human labels.
 *
 *   <AccessEndedNotice personName="Kushal Trivedi" labels={["Food preferences"]}
 *     reason="revoked" />
 *   -> "Kushal stopped sharing Food preferences. One no longer uses it."
 */
import { ShieldOff } from "@/components/icons";
import { firstName, formatDay, joinLabels } from "./request-progress";

export type AccessEndedReason = "revoked" | "expired";

export type AccessEndedNoticeProps = {
  personName: string;
  /** Human labels ("Food preferences"); never scope references. */
  labels: string[];
  reason: AccessEndedReason;
  /** ISO time access ended, for the expired wording. */
  endedAt?: string | null;
  /** "card" sits inside the consent card; "message" replaces a chat reply. */
  variant?: "card" | "message";
  className?: string;
};

export function accessEndedSentence({ personName, labels, reason, endedAt }: Pick<AccessEndedNoticeProps,
  "personName" | "labels" | "reason" | "endedAt">): string {
  const name = firstName(personName);
  const what = joinLabels(labels);
  if (reason === "revoked") return `${name} stopped sharing ${what}. One no longer uses it.`;
  const day = formatDay(endedAt);
  return `Access to ${what} from ${name} ended${day ? ` ${day}` : ""}. One no longer uses it.`;
}

export function AccessEndedNotice({ variant = "card", className, ...props }: AccessEndedNoticeProps) {
  return (
    <div role="status" data-testid="access-ended-notice" data-variant={variant}
      className={[
        "flex items-start gap-3 text-sm leading-6 text-muted-foreground",
        variant === "card" ? "rounded-[var(--app-card-radius-compact)] bg-muted/50 px-3.5 py-3" : "py-1",
        className,
      ].filter(Boolean).join(" ")}>
      <ShieldOff className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0">
        {/* Inside the card the header already says "Access ended". */}
        {variant === "message" ? <span className="block font-medium text-foreground">Access ended</span> : null}
        {accessEndedSentence(props)}
      </p>
    </div>
  );
}
