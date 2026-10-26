"use client"

import * as React from "react"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "@/components/icons"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { useNativeNavigationOverlayRef } from "@/lib/capacitor/native-navigation"
import { useNativeOverlayCollisionPadding } from "@/lib/capacitor/native-presentation-regions"
import { nativeOwnedChoicesEnabled } from "@/lib/capacitor/native-presentation-policy"
import { captureNativeDrawerOwner } from "@/lib/capacitor/native-drawer-owner"
import { collectImmediateChoices } from "@/lib/capacitor/native-choice-items"
import { NativeChoiceTriggerContext } from "@/lib/capacitor/use-native-owned-choice"
import { NativeChoiceController, type NativeChoiceControl } from "@/lib/capacitor/native-choice-controller"
import { isSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression"

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const { value: authoredValue, onValueChange, open, onOpenChange } = props
  const [native] = React.useState(() => nativeOwnedChoicesEnabled() && !isSessionChromeSuppressed() && !!captureNativeDrawerOwner() &&
    props.open === undefined && props.onOpenChange === undefined && props.defaultOpen !== true && props.dir === undefined &&
    immediateChoices(props.children) !== null)
  const [localValue, setLocalValue] = React.useState(props.defaultValue ?? "")
  const [fallback, setFallback] = React.useState(false)
  const [fallbackOpen, setFallbackOpen] = React.useState(false)
  const [control, setControl] = React.useState<NativeChoiceControl | null>(null)
  const trigger = React.useRef<HTMLButtonElement | null>(null)
  const bindTrigger = React.useCallback((node: HTMLButtonElement | null) => { trigger.current = node }, [])
  const current = React.useRef<NativeChoiceControl | null>(null)
  const value = props.value ?? localValue
  const publish = React.useCallback((next: NativeChoiceControl | null) => {
    current.current = next
    setControl(next)
    if (next?.fallback) { setFallbackOpen(next.presented); setFallback(true) }
  }, [])
  const updateValue = React.useCallback((next: string) => {
    if (next === value) return
    if (authoredValue === undefined) setLocalValue(next)
    onValueChange?.(next)
  }, [authoredValue, value, onValueChange])
  const requestOpen = React.useCallback((open: boolean) => current.current?.requestOpen(open), [])
  const eligible = open === undefined && onOpenChange === undefined && props.dir === undefined
  return <NativeChoiceTriggerContext.Provider value={native && !fallback ? { ...control, presented: control?.presented ?? false,
    blocked: control?.blocked ?? false, bindTrigger } : null}>
    <SelectPrimitive.Root data-slot="select" {...props}
      value={native ? value : props.value} onValueChange={native ? updateValue : props.onValueChange}
      open={native ? fallback ? open ?? fallbackOpen : false : open}
      onOpenChange={native ? fallback ? next => { setFallbackOpen(next); onOpenChange?.(next) } : requestOpen : onOpenChange}>
      {props.children}
      <NativeChoiceController active={native && !fallback} options={native && eligible ? immediateChoices(props.children) : null}
        value={value} disabled={props.disabled === true} onValueChange={updateValue} publish={publish} trigger={trigger} />
    </SelectPrimitive.Root>
  </NativeChoiceTriggerContext.Provider>
}

function immediateChoices(children: React.ReactNode) {
  return collectImmediateChoices(children, { trigger: SelectTrigger, content: SelectContent, item: SelectItem, group: SelectGroup })
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ref,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  const native = React.useContext(NativeChoiceTriggerContext)
  const bindTrigger = native?.bindTrigger
  const composedRef = React.useCallback((node: HTMLButtonElement | null) => {
    bindTrigger?.(node)
    if (typeof ref === "function") {
      const cleanup = ref(node)
      if (typeof cleanup === "function") return () => {
        bindTrigger?.(null)
        cleanup()
      }
    } else if (ref) ref.current = node
    return undefined
  }, [ref, bindTrigger])
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-[var(--app-input-radius)] border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
      ref={composedRef}
      {...(native && (native.presented || native.blocked) ? { "aria-expanded": native.presented, "aria-haspopup": "dialog" as const,
        "aria-controls": undefined, "data-state": native.presented ? "open" : "closed",
        "aria-busy": native.blocked || undefined } : {})}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  ref,
  className,
  children,
  position = "popper",
  align = "center",
  collisionPadding,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const overlayRef = useNativeNavigationOverlayRef<HTMLDivElement>(ref)
  const nativePadding = useNativeOverlayCollisionPadding(collisionPadding)
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={overlayRef}
        data-slot="select-content"
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:data-[state=closed]:slide-out-to-top-2 data-[side=left]:data-[state=closed]:slide-out-to-right-2 data-[side=right]:data-[state=closed]:slide-out-to-left-2 data-[side=top]:data-[state=closed]:slide-out-to-bottom-2 relative z-(--z-transient) max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        align={align}
        collisionPadding={nativePadding}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          {/* `text-current` opts the tick out of the item's
              `[&_svg:not([class*='text-'])]:text-muted-foreground` rule so it
              inherits the row's own colour. On a highlighted row that is
              `accent-foreground`, which keeps the tick legible against the solid
              accent fill instead of leaving muted grey on blue. */}
          <CheckIcon className="size-4 text-current" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
