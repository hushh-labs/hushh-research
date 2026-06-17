"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

function Dialog({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return React.createElement(DialogPrimitive.Root, {
    "data-slot": "dialog",
    ...props,
    children,
  } as any);
}

function DialogTrigger({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return React.createElement(DialogPrimitive.Trigger, {
    "data-slot": "dialog-trigger",
    ...props,
    children,
  } as any);
}

function DialogPortal({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return React.createElement(DialogPrimitive.Portal, {
    "data-slot": "dialog-portal",
    ...props,
    children,
  } as any);
}

function DialogClose({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return React.createElement(DialogPrimitive.Close, {
    "data-slot": "dialog-close",
    ...props,
    children,
  } as any);
}

// DialogOverlay
function DialogOverlay({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return React.createElement(DialogPrimitive.Overlay, {
    "data-slot": "dialog-overlay",
    className: cn(
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[499] bg-transparent touch-none",
      className
    ),
    ...props,
    children,
  } as any);
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[499] bg-black/22 backdrop-blur-[8px]"
      />
      <DialogOverlay />
      {React.createElement(
        DialogPrimitive.Content,
        {
          "data-slot": "dialog-content",
          className: cn(
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-[500] flex w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] flex-col gap-4 rounded-[var(--app-card-radius-feature)] border bg-[color:var(--app-card-surface-default-solid)] p-6 shadow-[var(--app-card-shadow-feature)] duration-200 translate-x-[-50%] translate-y-[-50%] outline-none sm:max-w-lg",
            className
          ),
          ...props,
        } as any,
        <>
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
        </>
      )}
    </DialogPortal>
  );
}

function DialogHeader({ className, children, ...props }: React.ComponentProps<"div">) {
  return React.createElement("div", {
    "data-slot": "dialog-header",
    className: cn("flex flex-col gap-2 text-center sm:text-left", className),
    ...props,
    children,
  } as any);
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return React.createElement(
    "div",
    {
      "data-slot": "dialog-footer",
      className: cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className),
      ...props,
    } as any,
    <>
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </>
  );
}

function DialogTitle({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return React.createElement(DialogPrimitive.Title, {
    "data-slot": "dialog-title",
    className: cn("text-lg font-semibold leading-none", className),
    ...props,
    children,
  } as any);
}

function DialogDescription({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return React.createElement(DialogPrimitive.Description, {
    "data-slot": "dialog-description",
    className: cn("text-sm text-muted-foreground", className),
    ...props,
    children,
  } as any);
}

export {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger,
};