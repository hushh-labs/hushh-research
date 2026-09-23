"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { HelperText, MediumRowLabel } from "@/components/app-ui/typography";

type FlowActionGroupProps = {
  primary: ReactNode;
  secondary?: ReactNode;
  tertiary?: ReactNode;
  className?: string;
  /** Keep actions stacked at every width for narrow sheets and cards. */
  stacked?: boolean;
  /** Caps final flow actions to a readable decision width. */
  measure?: "full" | "decision";
  "data-testid"?: string;
};

/**
 * Canonical two-action composition.
 *
 * Phone: secondary above primary, both full width.
 * Tablet/desktop: secondary left, primary right, content width.
 * The slots make the hierarchy independent from call-site DOM ordering.
 */
export function FlowActionGroup({
  primary,
  secondary,
  tertiary,
  className,
  stacked = false,
  measure = "full",
  "data-testid": testId,
}: FlowActionGroupProps) {
  return (
    <div
      data-ui-role="flow-actions"
      data-testid={testId}
      className={cn(
        "w-full",
        measure === "decision" && "mx-auto max-w-[30rem]",
        className,
      )}
    >
      <div
        className={cn(
          "grid w-full gap-2.5",
          !stacked && "sm:flex sm:items-center sm:justify-end",
        )}
      >
        {secondary ? (
          <div
            data-action-priority="secondary"
            className={cn("w-full", !stacked && "sm:w-auto", "[&>*]:w-full")}
          >
            {secondary}
          </div>
        ) : null}
        <div
          data-action-priority="primary"
          className={cn("w-full", !stacked && "sm:w-auto", "[&>*]:w-full")}
        >
          {primary}
        </div>
      </div>
      {tertiary ? (
        <div
          data-action-priority="tertiary"
          className="mt-2 flex min-h-11 items-center justify-center text-center"
        >
          {tertiary}
        </div>
      ) : null}
    </div>
  );
}

export function FlowSelectionSummary({
  label = "Selected",
  value,
  detail,
  className,
}: {
  label?: string;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-ui-role="selection-summary"
      className={cn(
        "flex min-h-11 items-center justify-between gap-4 rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-secondary-fill)] px-4 py-3",
        className,
      )}
    >
      <HelperText as="span" className="shrink-0">
        {label}
      </HelperText>
      <span className="min-w-0 text-right">
        <MediumRowLabel as="span" className="block">
          {value}
        </MediumRowLabel>
        {detail ? (
          <HelperText as="span" className="mt-0.5 block">
            {detail}
          </HelperText>
        ) : null}
      </span>
    </div>
  );
}
