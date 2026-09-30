"use client";

import { Capacitor } from "@capacitor/core";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";

export type ConnectorConfirmCopy = {
  title: string;
  description: string;
  /** The verb on the destructive button: "Disconnect", "Remove". */
  action: string;
};

/**
 * The words for each connection change, kept in one place so the phone's
 * sheet and the web dialog cannot drift apart.
 */
export function connectorConfirmCopy(target: string): ConnectorConfirmCopy {
  if (target === "mail")
    return {
      title: "Disconnect Mail?",
      description: "Drive stays connected.",
      action: "Disconnect",
    };
  if (target === "drive")
    return {
      title: "Disconnect Google Drive?",
      description:
        "This removes its selected files from One. Existing Google sharing stays active until you revoke it. Mail stays connected.",
      action: "Disconnect",
    };
  if (target === "calendar")
    return {
      title: "Disconnect Calendar?",
      description: "Other connections stay active.",
      action: "Disconnect",
    };
  if (target.startsWith("plaid:"))
    return {
      title: "Disconnect this bank?",
      description:
        "This removes its connected financial records from your vault. Other banks stay connected.",
      action: "Disconnect",
    };
  return {
    title: "Remove this file from One?",
    description: "The original in Google Drive is unchanged.",
    action: "Remove",
  };
}

export type ConnectorConfirmPresentation = "sheet" | "dialog";

/**
 * A sheet from the bottom edge on the native app, a centred dialog on the web.
 * Read during render: the platform cannot change under a mounted screen, and
 * an effect would draw the wrong surface for a frame first.
 */
export function connectorConfirmPresentation(): ConnectorConfirmPresentation {
  return Capacitor.isNativePlatform() ? "sheet" : "dialog";
}

type ConnectorConfirmProps = {
  target: string | null;
  /** A change is already in flight; the destructive action waits for it. */
  busy: boolean;
  presentation?: ConnectorConfirmPresentation;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Asks before a connection changes. The row that asked keeps its place: the
 * question floats above the list instead of being appended below it, so
 * nothing the person is looking at moves.
 */
export function ConnectorConfirm({
  target,
  busy,
  presentation = connectorConfirmPresentation(),
  onConfirm,
  onCancel,
}: ConnectorConfirmProps) {
  const open = target !== null;
  const copy = connectorConfirmCopy(target ?? "");
  const handleOpenChange = (next: boolean) => {
    if (!next) onCancel();
  };

  if (presentation === "sheet") {
    return (
      <Drawer modal open={open} onOpenChange={handleOpenChange}>
        <DrawerContent
          data-testid="connector-confirm-sheet"
          className="rounded-t-[20px] pb-[max(12px,env(safe-area-inset-bottom))] motion-reduce:transition-none"
        >
          <div className="px-4 pt-2">
            <DrawerTitle className="text-[17px] leading-[22px]">
              {copy.title}
            </DrawerTitle>
            <DrawerDescription className="mt-1 text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
              {copy.description}
            </DrawerDescription>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                type="button"
                variant="destructive"
                className="h-12 w-full rounded-[14px] text-[17px] font-semibold"
                disabled={busy}
                onClick={onConfirm}
              >
                {copy.action}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-12 w-full rounded-[14px] text-[17px] font-semibold text-foreground"
                onClick={onCancel}
              >
                Cancel
              </Button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        size="sm"
        data-testid="connector-confirm-dialog"
        className="motion-reduce:animate-none"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              // The panel closes the question itself once the change starts;
              // letting Radix close it too would race a second close.
              event.preventDefault();
              onConfirm();
            }}
          >
            {copy.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
