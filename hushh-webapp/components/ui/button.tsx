import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { Loader2 } from "@/components/icons"
import { cn } from "@/lib/utils"
import {
  buttonVariants,
  type ButtonVariantProps,
} from "@/lib/ui/button-variants"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    ButtonVariantProps {
  asChild?: boolean
  isLoading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      isLoading = false,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button"

    // When using asChild, we must ensure only one child is passed to Slot.
    // If loading, we handle the content inside a single span.
    //
    // While loading, keep the original label in the flow but invisible so the
    // button preserves its width, and overlay the spinner absolutely centered
    // over it. The previous approach put the spinner inline with `mr-2` beside
    // the hidden label, so the whole group centered as a block and the spinner
    // rendered left of the button's true center. Absolute centering pins it to
    // the exact middle regardless of label width.
    const content = isLoading ? (
      <span className="relative inline-flex items-center justify-center">
        {/* NOT aria-hidden. It is visually hidden to reserve the width, but
            hiding it from the accessibility tree too left a loading button
            with NO accessible name at all — the spinner beside it is
            aria-hidden as well, so screen readers announced an unlabelled
            button, and a long wait had nothing to identify it. */}
        <span className="opacity-0">{children}</span>
        <span className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        </span>
      </span>
    ) : (
      children
    )

    return (
      <Comp
        type={asChild ? undefined : "button"}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        aria-busy={isLoading || undefined}
        disabled={disabled || isLoading}
        {...props}
      >
        {asChild ? React.Children.only(children) : content}
      </Comp>
    )
  },
)

Button.displayName = "Button"

export { Button, buttonVariants }
