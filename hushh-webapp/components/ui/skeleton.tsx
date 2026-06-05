import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        "pointer-events-none overflow-hidden rounded-md bg-accent motion-safe:animate-pulse [contain:layout_paint]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
