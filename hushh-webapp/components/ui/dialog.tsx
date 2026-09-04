"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple"

function Dialog({
  modal = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" modal={modal} {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // The blur/scrim lives on the Radix overlay itself so it shares the
        // open/close lifecycle and fades OUT on close instead of snapping.
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[499] touch-none bg-black/22 backdrop-blur-[8px] [-webkit-backdrop-filter:blur(8px)]",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  srDescription = "Dialog content",
  overlayClassName,
  overlayStyle,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** Accessible context for dialogs whose explanatory copy is intentionally hidden. */
  srDescription?: React.ReactNode
  overlayClassName?: string
  overlayStyle?: React.CSSProperties
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} style={overlayStyle} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // Keyboard avoidance for this centered dialog is handled in globals.css
          // (`html.kb-open [data-slot="dialog-content"]`): max-h shrinks by
          // --kb-height and it shifts up by half of it, so it stays in the band
          // above the on-screen keyboard. Inert on desktop (kb-open never set). B21.
          //
          // Safe-area avoidance: the dialog is vertically centered, so a tall
          // one grows equally up and down. Subtracting the top + bottom insets
          // from max-height caps that growth, keeping the centered top edge
          // clear of the iOS Dynamic Island / status bar (which otherwise
          // clipped the title and close button). `--app-safe-area-top-effective`
          // is the probe-backed inset (min 44px on iOS native, 0 on desktop),
          // so this is inert on the web where both insets resolve to 0.
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-[500] flex w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem-var(--app-safe-area-top-effective,0px)-env(safe-area-inset-bottom,0px))] min-h-0 flex-col overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-[var(--app-card-radius-feature)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-6 shadow-[var(--app-card-shadow-feature)] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] outline-none sm:max-w-lg",
          className
        )}
        {...props}
      >
        <DialogDescription className="sr-only">
          {srDescription}
        </DialogDescription>

        {children}

        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring group absolute top-4 right-4 z-30 isolate overflow-hidden rounded-full border border-transparent bg-[color:var(--app-card-surface-compact)] p-2 opacity-70 transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:opacity-100 active:scale-[0.97] focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <MaterialRipple variant="none" effect="fade" className="z-10" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
