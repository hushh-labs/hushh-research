"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

type SheetRootProps = React.ComponentProps<typeof SheetPrimitive.Root>

type SheetContextValue = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SheetContext = React.createContext<SheetContextValue | null>(null)

function Sheet({
  modal = false,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  ...props
}: SheetRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isControlled = typeof controlledOpen === "boolean"
  const open = isControlled ? controlledOpen : uncontrolledOpen

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen)
      }
      onOpenChange?.(nextOpen)
    },
    [isControlled, onOpenChange],
  )

  return (
    <SheetContext.Provider value={{ open, onOpenChange: handleOpenChange }}>
      <SheetPrimitive.Root
        data-slot="sheet"
        modal={modal}
        open={open}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </SheetContext.Provider>
  )
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        // Blur/scrim rides the Radix overlay lifecycle so it fades OUT on close.
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[711] touch-none bg-black/22 backdrop-blur-[8px] [-webkit-backdrop-filter:blur(8px)] data-[state=closed]:duration-[180ms] data-[state=closed]:ease-[cubic-bezier(0.4,0,1,1)] data-[state=open]:duration-[240ms] data-[state=open]:ease-[cubic-bezier(0.2,0,0,1)]",
        className
      )}
      {...props}
    />
  )
}

type SheetContentProps =
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
    side?: "top" | "right" | "bottom" | "left"
    showCloseButton?: boolean
    /**
     * Enables the native-style downward drag dismissal used by mobile bottom
     * sheets. Bottom sheets opt in by default; other sides are unaffected.
     */
    dragDismiss?: boolean
    /** Renders the accessible drag affordance above a draggable bottom sheet. */
    showDragHandle?: boolean
    /** Optional surface-specific scrim treatment for a semantic app sheet. */
    overlayClassName?: string
  }

function SheetContent(
  {
    className,
    children,
    side = "right",
    showCloseButton = true,
    dragDismiss = true,
    showDragHandle,
    overlayClassName,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    ...props
  }: SheetContentProps,
) {
  const sheet = React.useContext(SheetContext)
  const {
    setSheetContentRef,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerEnd,
    onContentPointerDown,
    onContentPointerMove,
    onContentPointerEnd,
  } = useBottomSheetDragDismiss({
    enabled: side === "bottom" && dragDismiss,
    open: sheet?.open ?? false,
    onOpenChange: sheet?.onOpenChange ?? (() => undefined),
  })
  const shouldShowDragHandle =
    side === "bottom" && dragDismiss && (showDragHandle ?? true)

  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        ref={setSheetContentRef}
        data-slot="sheet-content"
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-[712] flex flex-col gap-4 border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-feature)] transition data-[state=closed]:duration-[180ms] data-[state=closed]:ease-[cubic-bezier(0.4,0,1,1)] data-[state=open]:duration-[240ms] data-[state=open]:ease-[cubic-bezier(0.2,0,0,1)]",
          side === "right" &&
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm sm:rounded-l-[var(--app-card-radius-feature)]",
          side === "left" &&
            "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm sm:rounded-r-[var(--app-card-radius-feature)]",
          side === "top" &&
            "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b rounded-b-[var(--app-card-radius-feature)]",
          // bottom sheet lifts above the on-screen keyboard by --kb-height
          // (KeyboardInsetManager; 0 on desktop → inert), max-h shrinks to match.
          side === "bottom" &&
            "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-[var(--kb-height,0px)] h-auto max-h-[calc(85dvh-var(--kb-height,0px))] overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] border-t rounded-t-[var(--app-card-radius-feature)]",
          className
        )}
        onPointerDown={(event) => {
          onContentPointerDown(event)
          onPointerDown?.(event)
        }}
        onPointerMove={(event) => {
          onContentPointerMove(event)
          onPointerMove?.(event)
        }}
        onPointerUp={(event) => {
          onContentPointerEnd(event)
          onPointerUp?.(event)
        }}
        onPointerCancel={(event) => {
          onContentPointerEnd(event)
          onPointerCancel?.(event)
        }}
        {...props}
      >
        {shouldShowDragHandle ? (
          <div
            data-slot="sheet-drag-handle"
            className="sticky top-0 z-[5] flex h-11 shrink-0 touch-none select-none items-center justify-center bg-[color:var(--app-card-surface-default-solid)] sm:hidden"
            role="button"
            tabIndex={0}
            aria-label="Drag down to close"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerEnd}
            onPointerCancel={onHandlePointerEnd}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                sheet?.onOpenChange(false)
              }
            }}
          >
            <span
              className="h-1.5 w-12 rounded-full bg-muted-foreground/35"
              aria-hidden="true"
            />
          </div>
        ) : null}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-full border border-transparent bg-[color:var(--app-card-surface-compact)] p-2 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

SheetContent.displayName = SheetPrimitive.Content.displayName

type BottomSheetDragState = {
  startY: number
  lastY: number
  lastT: number
  fromContent?: boolean
  engaged: boolean
}

/**
 * Keeps the physical bottom-sheet contract next to the shadcn primitive.
 * The thresholds and transform lifecycle match the proven Search Console
 * mobile sheet: small moves remain taps, content can dismiss only from its
 * scroll origin, and a cancelled pull settles without replaying the entry keyframe.
 */
function useBottomSheetDragDismiss({
  enabled,
  open,
  onOpenChange,
}: {
  enabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const sheetContentRef = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef<BottomSheetDragState | null>(null)
  const setSheetContentRef = React.useCallback((node: HTMLDivElement | null) => {
    sheetContentRef.current = node
  }, [])

  React.useEffect(() => {
    if (!enabled || !open) return
    const surface = sheetContentRef.current
    if (!surface) return
    surface.style.transform = ""
    surface.style.transition = ""
    surface.style.animation = ""
    surface.style.willChange = ""
  }, [enabled, open])

  const finishDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const surface = sheetContentRef.current
      dragRef.current = null
      if (!enabled || !drag || !surface) return

      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture is best-effort on embedded and native web views.
      }

      if (!drag.engaged) return

      const distance = event.clientY - drag.startY
      const elapsed = Math.max(1, event.timeStamp - drag.lastT)
      const velocity = (event.clientY - drag.lastY) / elapsed
      surface.style.transition = "transform 240ms cubic-bezier(0.32,0.72,0,1)"

      if (distance > 96 || velocity > 0.5) {
        // Keep the direct transform until Radix begins its close lifecycle.
        // Clearing it first lets the completed entry animation flash back in.
        surface.style.transform = "translate3d(0, 100%, 0)"
        window.setTimeout(() => onOpenChange(false), 220)
        return
      }

      surface.style.transform = "translate3d(0, 0, 0)"
      window.setTimeout(() => {
        surface.style.transform = ""
        surface.style.transition = ""
        surface.style.willChange = ""
        // Preserve the settled open state rather than replaying the entry animation.
        surface.style.animation = "none"
      }, 260)
    },
    [enabled, onOpenChange],
  )

  const onHandlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled) return
      dragRef.current = {
        startY: event.clientY,
        lastY: event.clientY,
        lastT: event.timeStamp,
        engaged: false,
      }
    },
    [enabled],
  )

  const onHandlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const surface = sheetContentRef.current
      if (!enabled || !drag || !surface) return

      const delta = Math.max(0, event.clientY - drag.startY)
      if (!drag.engaged) {
        if (delta < 4) return
        drag.engaged = true
        surface.style.animation = "none"
        surface.style.transition = "none"
        surface.style.willChange = "transform"
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Pointer capture is best-effort on embedded and native web views.
        }
      }

      drag.lastY = event.clientY
      drag.lastT = event.timeStamp
      surface.style.transform = `translate3d(0, ${delta}px, 0)`
    },
    [enabled],
  )

  const onContentPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || event.button !== 0 || dragRef.current?.engaged) return
      dragRef.current = {
        startY: event.clientY,
        lastY: event.clientY,
        lastT: event.timeStamp,
        fromContent: true,
        engaged: false,
      }
    },
    [enabled],
  )

  const onContentPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const surface = sheetContentRef.current
      if (!enabled || !drag || !surface || !drag.fromContent) return

      if (!drag.engaged) {
        const movedDown = event.clientY - drag.startY
        if (surface.scrollTop <= 0 && movedDown > 6) {
          drag.engaged = true
          drag.startY = event.clientY
          surface.style.animation = "none"
          surface.style.transition = "none"
          surface.style.willChange = "transform"
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // Pointer capture is best-effort on embedded and native web views.
          }
        } else {
          return
        }
      }

      event.preventDefault()
      const delta = Math.max(0, event.clientY - drag.startY)
      drag.lastY = event.clientY
      drag.lastT = event.timeStamp
      surface.style.transform = `translate3d(0, ${delta}px, 0)`
    },
    [enabled],
  )

  const onContentPointerEnd = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!enabled || !drag || !drag.fromContent) return
      if (!drag.engaged) {
        dragRef.current = null
        return
      }
      finishDrag(event)
    },
    [enabled, finishDrag],
  )

  return {
    setSheetContentRef,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerEnd: finishDrag,
    onContentPointerDown,
    onContentPointerMove,
    onContentPointerEnd,
  }
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
