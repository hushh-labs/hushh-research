import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The field's own classes, before any caller's overrides.
 *
 * Exported so a real-browser layout contract can measure this input without
 * rebuilding (and then silently drifting from) the string that gives it its
 * height, padding and 17px value type. A fixture that hand-copies these stops
 * proving anything the first time one of them changes here.
 */
const INPUT_CLASSNAME = cn(
  "ui-text-input-value file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground h-11 w-full min-w-0 rounded-[var(--app-radius-md)] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3.5 py-2 shadow-none transition-[background-color,border-color,color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-semibold disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  "focus-visible:border-[color:var(--app-accent)] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"
)

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      autoCapitalize={type === "email" ? "none" : props.autoCapitalize}
      autoCorrect={type === "email" ? "off" : props.autoCorrect}
      spellCheck={type === "email" ? false : props.spellCheck}
      className={cn(INPUT_CLASSNAME, className)}
      {...props}
    />
  )
}

export { Input, INPUT_CLASSNAME }
