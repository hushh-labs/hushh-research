import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { Loader2 } from "@/components/icons"
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple"
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
  /**
   * The press ripple is on by default, from the pointerdown point and clipped
   * to the button's shape. Pass `false` only when the caller renders its own
   * ripple (the Morphy Button does), so a press never paints two layers.
   */
  showRipple?: boolean
}

type ButtonVariantName = NonNullable<ButtonVariantProps["variant"]>

// Solid fills take a currentColor ripple so the press reads against the
// fill; every other variant takes the lighter glass ripple.
function rippleEffectFor(variant: ButtonVariantProps["variant"]) {
  const filled: ReadonlyArray<ButtonVariantName> = ["default", "destructive"]
  return filled.includes(variant ?? "default") ? "fill" : "glass"
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      isLoading = false,
      showRipple = true,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button"
    const isDisabled = Boolean(disabled || isLoading)
    const ripple = showRipple ? (
      <MaterialRipple
        variant="none"
        effect={rippleEffectFor(variant)}
        disabled={isDisabled}
      />
    ) : null

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

    // Slot takes exactly one child, so under asChild the ripple rides inside
    // that child rather than beside it.
    const slotted = (() => {
      if (!asChild) return null
      const child = React.Children.only(children) as React.ReactElement<{
        children?: React.ReactNode
      }>
      if (!ripple || !React.isValidElement(child)) return child
      return React.cloneElement(child, {
        children: (
          <>
            {child.props.children}
            {ripple}
          </>
        ),
      })
    })()

    return (
      <Comp
        type={asChild ? undefined : "button"}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        aria-busy={isLoading || undefined}
        disabled={isDisabled}
        {...props}
      >
        {asChild ? (
          slotted
        ) : (
          <>
            {content}
            {ripple}
          </>
        )}
      </Comp>
    )
  },
)

Button.displayName = "Button"

export { Button, buttonVariants }
