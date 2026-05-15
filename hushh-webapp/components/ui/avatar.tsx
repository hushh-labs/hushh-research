"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & {
    size?: "default" | "sm" | "lg"
  }
>(({ className, size = "default", ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    data-slot="avatar"
    data-size={size}
    className={cn(
      "group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none",
      "data-[size=lg]:size-10 data-[size=sm]:size-6",
      "bg-background", // Ensures the background is solid for the ring effect
      className
    )}
    {...props}
  />
))
Avatar.displayName = AvatarPrimitive.Root.displayName

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    data-slot="avatar-image"
    className={cn("aspect-square size-full object-cover", className)}
    {...props}
  />
))
AvatarImage.displayName = AvatarPrimitive.Image.displayName

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, delayMs = 600, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    delayMs={delayMs}
    data-slot="avatar-fallback"
    className={cn(
      "bg-muted text-muted-foreground flex size-full items-center justify-center rounded-full text-[10px] font-medium uppercase",
      "group-data-[size=sm]/avatar:text-[8px] group-data-[size=lg]/avatar:text-xs",
      className
    )}
    {...props}
  />
))
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

const AvatarBadge = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    data-slot="avatar-badge"
    className={cn(
      "bg-primary text-primary-foreground ring-background absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full ring-2 select-none",
      "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
      "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
      "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
      className
    )}
    {...props}
  />
))
AvatarBadge.displayName = "AvatarBadge"

const AvatarGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { size?: "default" | "sm" | "lg" }
>(({ className, size = "default", ...props }, ref) => (
  <div
    ref={ref}
    data-slot="avatar-group"
    data-size={size}
    className={cn(
      "group/avatar-group flex -space-x-2 isolate",
      "*:data-[slot=avatar]:ring-background *:data-[slot=avatar]:ring-2",
      "*:data-[slot=avatar]:transition-transform *:data-[slot=avatar]:duration-200 hover:*:data-[slot=avatar]:z-20 hover:*:data-[slot=avatar]:-translate-y-0.5",
      className
    )}
    {...props}
  />
))
AvatarGroup.displayName = "AvatarGroup"

const AvatarGroupCount = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="avatar-group-count"
    className={cn(
      "bg-muted text-muted-foreground ring-background relative flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium ring-2",
      "group-data-[size=lg]/avatar-group:size-10 group-data-[size=sm]/avatar-group:size-6",
      "group-data-[size=lg]/avatar-group:[&>svg]:size-5 group-data-[size=sm]/avatar-group:[&>svg]:size-3 [&>svg]:size-4",
      className
    )}
    {...props}
  />
))
AvatarGroupCount.displayName = "AvatarGroupCount"

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
}