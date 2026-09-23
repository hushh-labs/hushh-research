import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        // Neutral, never the brand accent: in this system --accent IS the app
        // accent (blue or gold), and placeholders flashed saturated brand
        // colour in dark mode (Connect, Galaxy S24 Ultra, 2026-09-22).
        "pointer-events-none overflow-hidden rounded-md bg-muted motion-safe:animate-pulse [contain:layout_paint]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
