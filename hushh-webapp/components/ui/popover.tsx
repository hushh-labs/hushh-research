"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "@/lib/utils"

const SIZES = {
  sm: "w-48",
  md: "w-72",
  lg: "w-96",
};

function Popover({ modal = false, ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" modal={modal} {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

interface PopoverContentProps extends React.ComponentProps<typeof PopoverPrimitive.Content> {
  size?: keyof typeof SIZES;
  showArrow?: boolean;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 8,
  size = "md",
  showArrow = false,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground z-50 rounded-md border p-4 shadow-xl outline-none",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          SIZES[size],
          className
        )}
        {...props}
      >
        {props.children}
        {showArrow && <PopoverPrimitive.Arrow className="fill-popover border-none" />}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

// ... PopoverAnchor, PopoverHeader, PopoverTitle, PopoverDescription remain unchanged ...