import * as React from "react";

import { Button as MorphyButton, type ButtonProps } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

import styles from "./calendar-compact-action.module.css";

type CalendarCompactActionProps = Omit<ButtonProps, "variant" | "effect" | "size"> & {
  pillClassName?: string;
};

/** Connect's neutral accent pill, scoped to ordinary Calendar actions. */
export const CalendarCompactAction = React.forwardRef<HTMLButtonElement, CalendarCompactActionProps>(
  ({ children, className, pillClassName, ...props }, ref) => (
    <MorphyButton
      ref={ref}
      variant="none"
      effect="fade"
      size="compact"
      className={cn(styles.target, className)}
      {...props}
    >
      <span className={cn(styles.pill, pillClassName)}>{children}</span>
    </MorphyButton>
  ),
);

CalendarCompactAction.displayName = "CalendarCompactAction";
