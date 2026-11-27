import type { ComponentProps } from "react";
import { CaretDownIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import styles from "./calendar-presentation.module.css";

export function CalendarSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className={styles.selectField}>
      <select {...props} className={cn("ui-text-input-value", className)} />
      <CaretDownIcon aria-hidden className={styles.selectChevron} />
    </span>
  );
}
