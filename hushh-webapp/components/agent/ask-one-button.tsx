"use client";

import type { ComponentPropsWithoutRef } from "react";
import { MessageCircle } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

/**
 * The one control that opens One from inside a screen.
 *
 * Five surfaces had drawn their own: the Email Agent and Calendar used the
 * shared Button with a MessageCircle, the Gmail workspace used the same Button
 * with a Sparkles, and RIA's onboarding used a hand-rolled pill with inline
 * colours and a gold Sparkles. Same act, four appearances -- so "open One" read
 * as a different kind of thing on each screen.
 *
 * This is the shape the most screens already had: the shared Button, a
 * MessageCircle, full width on a phone and intrinsic above it. The label stays
 * with the caller, because what One is being asked to do IS different on each
 * screen -- only the button is not.
 */
export function AskOneButton({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof Button>) {
  return (
    <Button
      type="button"
      className={cn("w-full justify-center sm:w-auto", className)}
      {...props}
    >
      <MessageCircle className="h-4 w-4 shrink-0" aria-hidden />
      {children}
    </Button>
  );
}
