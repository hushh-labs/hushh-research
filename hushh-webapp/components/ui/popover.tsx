"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

const ModalPopoverContext = React.createContext(false)

function Popover({
  modal = false,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return (
    <ModalPopoverContext.Provider value={modal}>
      <PopoverPrimitive.Root data-slot="popover" modal={modal} {...props} />
    </ModalPopoverContext.Provider>
  )
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  withBackdrop,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  /**
   * Modal popovers inherit the shared scrim; non-modal anchored menus stay
   * flat. Override only when the interaction deliberately differs.
   */
  withBackdrop?: boolean
}) {
  const modal = React.useContext(ModalPopoverContext)
  const showBackdrop = withBackdrop ?? modal
  return (
    <PopoverPrimitive.Portal>
      {/*
        Radix's Portal forwards its children through React.Children.only, so it
        must receive exactly ONE React element. Passing the scrim and the
        content as two JSX siblings (even with the scrim as `null`) produces a
        children ARRAY and crashes every popover with
        "React.Children.only expected to receive a single React element
        child." Wrapping both in one Fragment keeps Portal's single-child
        contract while still conditionally rendering the scrim.
      */}
      <>
        {showBackdrop ? (
          <div
            data-slot="popover-scrim"
            aria-hidden
            className="fixed inset-0 z-(--z-transient-scrim) touch-none bg-[color:var(--app-scrim-color)] [backdrop-filter:var(--app-scrim-filter)] [-webkit-backdrop-filter:var(--app-scrim-filter)]"
          />
        ) : null}
        <PopoverPrimitive.Content
          data-slot="popover-content"
          align={align}
          sideOffset={sideOffset}
          className={cn(
            "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:data-[state=closed]:slide-out-to-top-2 data-[side=left]:data-[state=closed]:slide-out-to-right-2 data-[side=right]:data-[state=closed]:slide-out-to-left-2 data-[side=top]:data-[state=closed]:slide-out-to-bottom-2 z-(--z-transient) w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
            className
          )}
          {...props}
        />
      </>
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
}
