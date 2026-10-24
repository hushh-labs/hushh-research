"use client";

import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import styles from "./mail-workspace.module.css";

/** Connect's transparent target + neutral accent pill, with the shared ripple. */
export const MailActionButton = forwardRef<HTMLButtonElement, Omit<ComponentPropsWithoutRef<typeof Button>, "variant"> & { variant?: ComponentPropsWithoutRef<typeof Button>["variant"] | "outline" | "ghost" }>(function MailActionButton({ children, className, variant, ...props }, ref) {
  if (variant === "destructive") return <Button ref={ref} {...props} variant={variant} className={className}>{children}</Button>;
  return (
    <Button ref={ref} {...props} size="compact" variant="none" effect="fade" className={cn(styles.typography, styles.action, className)}>
      <span data-slot="mail-action-pill" className={styles.pill}>{children}</span>
    </Button>
  );
});
