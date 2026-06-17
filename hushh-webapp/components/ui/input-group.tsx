"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

function InputGroup({
  className,
  children,
  id,
  style,
  role,
  tabIndex,
  title,
  onClick,
  onFocus,
  onBlur,
  onKeyDown,
  onKeyUp,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  "aria-hidden": ariaHidden,
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role={role || "group"}
      id={id}
      style={style}
      tabIndex={tabIndex}
      title={title}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      aria-hidden={ariaHidden}
      className={cn(
        "group/input-group relative flex w-full items-center rounded-md border border-input shadow-xs transition-all",
        "has-[[data-slot=input-group-control]:focus-within]:ring-2 has-[[data-slot=input-group-control]:focus-within]:ring-ring/50 has-[[data-slot=input-group-control]:focus-within]:border-ring",
        "has-[[data-slot=input-group-control][aria-invalid=true]]:border-destructive has-[[data-slot=input-group-control][aria-invalid=true]]:ring-destructive/20",
        className
      )}
    >
      {children}
    </div>
  )
}

const inputGroupAddonVariants = cva(
  "flex h-full items-center justify-center px-3 text-sm text-muted-foreground transition-colors select-none",
  {
    variants: {
      align: {
        "inline-start": "border-r border-input",
        "inline-end": "border-l border-input",
      },
    },
    defaultVariants: { align: "inline-start" },
  }
)

function InputGroupAddon({
  className,
  children,
  align = "inline-start",
  id,
  style,
  onClick,
  onFocus,
  onBlur,
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      data-slot="input-group-addon"
      id={id}
      style={style}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(inputGroupAddonVariants({ align }), className)}
    >
      {children}
    </div>
  )
}

const InputGroupInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  (
    {
      className,
      type,
      value,
      defaultValue,
      placeholder,
      disabled,
      required,
      id,
      name,
      autoComplete,
      autoFocus,
      onChange,
      onFocus,
      onBlur,
      onKeyDown,
      onKeyUp,
      "aria-invalid": ariaInvalid,
      "aria-describedby": ariaDescribedby,
    },
    ref
  ) => (
    <Input
      ref={ref}
      data-slot="input-group-control"
      className={cn("flex-1 rounded-none border-0 shadow-none focus-visible:ring-0", className)}
      type={type}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      id={id}
      name={name}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedby}
    />
  )
)
InputGroupInput.displayName = "InputGroupInput"

const InputGroupTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  (
    {
      className,
      value,
      defaultValue,
      placeholder,
      disabled,
      required,
      id,
      name,
      rows,
      cols,
      onChange,
      onFocus,
      onBlur,
      onKeyDown,
      onKeyUp,
      "aria-invalid": ariaInvalid,
      "aria-describedby": ariaDescribedby,
    },
    ref
  ) => (
    <Textarea
      ref={ref}
      data-slot="input-group-control"
      className={cn("flex-1 rounded-none border-0 shadow-none focus-visible:ring-0", className)}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      id={id}
      name={name}
      rows={rows}
      cols={cols}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedby}
    />
  )
)
InputGroupTextarea.displayName = "InputGroupTextarea"

function InputGroupButton({
  className,
  children,
  onClick,
  disabled,
  type,
  id,
  title,
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("rounded-none", className)}
      onClick={onClick}
      disabled={disabled}
      type={type}
      id={id}
      title={title}
    >
      {children}
    </Button>
  )
}

function InputGroupText({
  className,
  children,
  id,
  style,
  onClick,
}: React.ComponentProps<"span">) {
  return (
    <span
      id={id}
      style={style}
      onClick={onClick}
      className={cn("px-3 text-sm text-muted-foreground", className)}
    >
      {children}
    </span>
  )
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
}