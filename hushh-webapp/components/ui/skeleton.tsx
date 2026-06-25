import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        "pointer-events-none min-w-0 max-w-full overflow-hidden rounded-md bg-accent motion-safe:animate-pulse [contain:layout_paint]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
