"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { AlertCircle, CheckCircle2, Info, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative w-full rounded-lg border p-4 text-sm grid has-[>svg]:grid-cols-[20px_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground border-border",
        destructive: "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
        success: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400 [&>svg]:text-emerald-600",
        warning: "border-amber-500/50 text-amber-700 dark:text-amber-400 [&>svg]:text-amber-600",
        info: "border-blue-500/50 text-blue-700 dark:text-blue-400 [&>svg]:text-blue-600",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

const ICONS = {
  default: Info,
  destructive: AlertCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
  info: Info,
}

interface AlertProps extends React.ComponentProps<"div">, VariantProps<typeof alertVariants> {
  showIcon?: boolean
}

function Alert({ className, variant = "default", showIcon = true, ...props }: AlertProps) {
  const Icon = ICONS[variant || "default"]

  return (
    <div
      data-slot="alert"
      role="alert"
      aria-live="polite"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {showIcon && <Icon className="size-4 translate-y-0.5" />}
      {props.children}
    </div>
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("col-start-2 font-semibold", className)} {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("col-start-2 text-sm opacity-90", className)} {...props} />
}

export { Alert, AlertTitle, AlertDescription }