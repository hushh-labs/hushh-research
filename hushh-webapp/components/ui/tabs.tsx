"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple"
import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center text-muted-foreground group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] p-1 shadow-[var(--app-card-shadow-standard)] backdrop-blur-xl group-data-[orientation=horizontal]/tabs:min-h-11",
        line: "gap-1 rounded-none bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function TabsList({ className, variant = "default", ...props }: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative isolate inline-flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden px-4 py-2 text-sm font-medium transition-all duration-300",
        "rounded-full border border-transparent",
        "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
        "data-[state=active]:bg-[color:var(--app-segmented-active-surface)] data-[state=active]:text-[color:var(--app-segmented-active-foreground)] data-[state=active]:font-semibold data-[state=active]:shadow-[var(--shadow-xs)]",
        "focus-visible:ring-[3px] focus-visible:ring-ring/40 outline-none",
        "group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100 after:absolute after:bg-foreground/20",
        className
      )}
      {...props}
    >
      <span className="relative z-10 flex items-center gap-1.5">{children}</span>
      <MaterialRipple variant="none" effect="fade" className="z-0" />
    </TabsPrimitive.Trigger>
  )
}

interface TabsContentProps extends React.ComponentProps<typeof TabsPrimitive.Content> {
  keepMounted?: boolean
}

function TabsContent({ className, keepMounted = false, ...props }: TabsContentProps) {
  // If keepMounted is false, Radix automatically removes content from DOM when inactive
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "flex-1 outline-none animate-in fade-in-50 duration-300",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }