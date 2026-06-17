"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  modal,
  children,
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      modal={modal}
    >
      {children}
    </DialogPrimitive.Root>
  );
}

function DialogTrigger({
  asChild,
  children,
  className,
  id,
  style,
  disabled,
  onClick,
  onKeyDown,
  onKeyUp,
  onFocus,
  onBlur,
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return (
    <DialogPrimitive.Trigger
      data-slot="dialog-trigger"
      asChild={asChild}
      className={className}
      id={id}
      style={style}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {children}
    </DialogPrimitive.Trigger>
  );
}

function DialogPortal({
  children,
  container,
  forceMount,
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      container={container}
      forceMount={forceMount}
    >
      {children}
    </DialogPrimitive.Portal>
  );
}

function DialogClose({
  asChild,
  children,
  className,
  id,
  style,
  disabled,
  onClick,
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      asChild={asChild}
      className={className}
      id={id}
      style={style}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </DialogPrimitive.Close>
  );
}

function DialogOverlay({
  asChild,
  children,
  className,
  style,
  id,
  forceMount,
  onClick,
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      asChild={asChild}
      style={style}
      id={id}
      forceMount={forceMount}
      onClick={onClick}
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[499] bg-transparent touch-none",
        className
      )}
    >
      {children}
    </DialogPrimitive.Overlay>
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  style,
  id,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  onInteractOutside,
  forceMount,
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[499] bg-black/22 backdrop-blur-[8px]"
      />
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        style={style}
        id={id}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={onEscapeKeyDown}
        onPointerDownOutside={onPointerDownOutside}
        onInteractOutside={onInteractOutside}
        forceMount={forceMount}
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-[500] flex w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] flex-col gap-4 rounded-[var(--app-card-radius-feature)] border bg-[color:var(--app-card-surface-default-solid)] p-6 shadow-[var(--app-card-shadow-feature)] duration-200 translate-x-[-50%] translate-y-[-50%] outline-none sm:max-w-lg",
          className
        )}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            className="absolute top-4 right-4 z-30 rounded-full border border-transparent bg-[color:var(--app-card-surface-compact)] p-2 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <XIcon className="size-4" />
            <MaterialRipple variant="none" effect="fade" className="z-10" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  children,
  id,
  style,
  onClick,
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      id={id}
      style={style}
      onClick={onClick}
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
    >
      {children}
    </div>
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  id,
  style,
  onClick,
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <div
      data-slot="dialog-footer"
      id={id}
      style={style}
      onClick={onClick}
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  children,
  id,
  style,
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      id={id}
      style={style}
      className={cn("text-lg font-semibold leading-none", className)}
    >
      {children}
    </DialogPrimitive.Title>
  );
}

function DialogDescription({
  className,
  children,
  id,
  style,
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      id={id}
      style={style}
      className={cn("text-sm text-muted-foreground", className)}
    >
      {children}
    </DialogPrimitive.Description>
  );
}

export {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger,
};