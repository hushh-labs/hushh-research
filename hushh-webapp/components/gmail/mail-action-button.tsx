"use client";

import type { ComponentPropsWithoutRef } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import styles from "./mail-workspace.module.css";

/** Connect's transparent target + neutral accent pill, with the shared ripple. */
export function MailActionButton({ children, className, variant, ...props }: Omit<ComponentPropsWithoutRef<typeof Button>, "variant"> & { variant?: ComponentPropsWithoutRef<typeof Button>["variant"] | "outline" | "ghost" }) {
  if (variant === "destructive") return <Button {...props} variant={variant} className={className}>{children}</Button>;
  return (
    <Button {...props} size="compact" variant="none" effect="fade" className={cn(styles.typography, styles.action, className)}>
      <span data-slot="mail-action-pill" className={styles.pill}>{children}</span>
    </Button>
  );
}
