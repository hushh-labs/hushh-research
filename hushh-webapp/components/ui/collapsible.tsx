"use client";

import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "@/lib/utils";

function Collapsible({
  open,
  defaultOpen,
  onOpenChange,
  disabled,
  asChild,
  children,
  className,
  id,
  style,
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      disabled={disabled}
      asChild={asChild}
      id={id}
      style={style}
      className={className}
    >
      {children}
    </CollapsiblePrimitive.Root>
  );
}

function CollapsibleTrigger({
  className,
  asChild,
  children,
  id,
  style,
  disabled,
  onClick,
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      asChild={asChild}
      id={id}
      style={style}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center justify-between w-full transition-all [&[data-state=open]>svg]:rotate-180",
        className
      )}
    >
      {children}
    </CollapsiblePrimitive.CollapsibleTrigger>
  );
}

function CollapsibleContent({
  className,
  asChild,
  children,
  id,
  style,
  forceMount,
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      asChild={asChild}
      id={id}
      style={style}
      forceMount={forceMount}
      className={cn(
        "overflow-hidden transition-all data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
        className
      )}
    >
      {children}
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };