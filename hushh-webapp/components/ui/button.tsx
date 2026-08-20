import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-[color:var(--app-accent)] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive touch-manipulation",
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]",
        destructive:
          "bg-[color:var(--app-destructive)] text-white hover:[background-color:color-mix(in_srgb,var(--app-destructive)_88%,black_12%)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-[color:var(--app-separator)] bg-[color:var(--app-neutral-fill)] text-foreground shadow-none hover:bg-[color:var(--app-neutral-fill-strong)] dark:border-[color:var(--app-separator)]",
        secondary:
          "bg-[color:var(--app-neutral-fill)] text-foreground hover:bg-[color:var(--app-neutral-fill-strong)]",
        ghost:
          "text-[color:var(--app-accent)] hover:bg-[color:var(--app-accent-tint)]",
        link: "min-h-0 rounded-none text-[color:var(--app-accent)] underline-offset-4 hover:underline",
      },
      size: {
        default:
          "ui-text-button-label min-h-[50px] h-[50px] px-4 py-3 has-[>svg]:px-3",
        xs: "min-h-7 h-7 gap-1 rounded-[var(--app-radius-sm)] px-2 text-[13px] font-semibold leading-[18px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-9 h-9 rounded-[var(--app-radius-md)] gap-1.5 px-3 text-[15px] font-semibold leading-[20px] has-[>svg]:px-2.5",
        lg: "ui-text-button-label min-h-[50px] h-[50px] rounded-full px-6 has-[>svg]:px-4",
        icon: "size-9 rounded-full",
        "icon-xs": "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
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
